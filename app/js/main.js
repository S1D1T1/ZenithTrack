/**
 * main.js - ZenithTrack Phase 1
 *
 * Wires together: Leaflet map, zenith tracker, clock, grid, and HUD.
 *
 * Architecture:
 *   - Leaflet viewport is FIXED. It never pans or zooms.
 *   - The Clock drives a requestAnimationFrame loop.
 *   - Each frame, we compute the current zenith RA/Dec from the real clock.
 *   - We convert celestial coordinates to Leaflet's XY space and reposition
 *     all content (grid lines, future overlays) accordingly.
 *   - The "scrolling" illusion comes from content moving through a fixed viewport.
 *
 * Coordinate mapping:
 *   - Leaflet CRS.Simple uses [y, x] (like [lat, lng]).
 *   - We map RA to X (increasing RA = decreasing X, matching PanSTARRS orientation).
 *   - We map Dec to Y (increasing Dec = increasing Y).
 *   - Scale: 1 degree = an arbitrary number of Leaflet units. We choose a scale
 *     so that the FOV (2.5 arcmin) fills the screen nicely.
 */

import { zenithPosition, formatRA, formatDec } from './zenith.js';
import { Clock } from './clock.js';
import { GridLayer } from './grid.js';
import { LabelLayer } from './labels.js';
import { ImageLayer } from './image-layer.js';
import { PanSTARRSImageSource, setTileSizeArcmin } from './image-source.js';
import { SimbadClient } from './simbad.js';
import { Highlights } from './highlights.js';
import { HUD } from './hud.js';

// --- Configuration ---

const CONFIG = {
    // Field of view in arcminutes.
    // 2.5 = original design (objects cross screen in ~10-20s)
    // 5.0 = 2x wider, objects take ~20-40s to cross
    // 10.0 = 4x wider, leisurely pace
    fovArcmin: 10.0,

    // Tile size in arcminutes. Larger = fewer API calls & seams, bigger downloads.
    // 5 = 1200px (default), 10 = 2400px, 15 = 3600px, 25 = 6000px (max)
    tileSizeArcmin: 10,

    // Diagnostic mode: show coordinates on SIMBAD labels and tile corners
    diagnostic: false,

    // Diagnostic coordinate lock: if set, ignore location/time and point here.
    // Set to { ra: degrees, dec: degrees } to lock, or null to disable.
    // Example: M51 = { ra: 202.4696, dec: 47.1953 }
    //   RA  13h 30m = 13.5 * 15 = 202.5°
    //   Dec +47° 11' = 47 + 11/60 = 47.1833°
    diagnostic_coordinate_lock: null,

    // Grid spacing in arcminutes
    gridSpacingArcmin: 0.5,

    // HUD update interval in ms
    hudUpdateMs: 1000,

    // Default location: Stonehenge
    defaultLat: 51.1789,
    defaultLon: -1.8262,

    // SIMBAD label magnitude limit.
    // Controls how many objects appear as labels on the sky.
    // Lower = fewer, brighter objects only. Higher = more, fainter objects.
    //   10 = just the brightest handful (e.g. M87, named stars)
    //   14 = bright stars + prominent galaxies
    //   18 = good default — recognizable objects without clutter
    //   22 = everything SIMBAD has (dense, lots of catalog IDs)
    simbadMagnitudeLimit: 21,

    // Show the freeze checkbox (diagnostic tool, hide for public release)
    showFreeze: false,

    // Number of highlight objects to query from SIMBAD.
    // 8 = default for production. Increase while testing to reduce wait time.
    highlightCount: 28,

    // Show tile download metrics in the HUD (tile count, total size, avg bandwidth).
    // Useful for estimating server impact at scale.
    downloadMetrics: true,

    // Time offset in minutes for testing. Added to the real clock.
    // +30 = app sees 30 minutes in the future, -60 = one hour in the past.
    timeOffsetMinutes: 0,

    // Leaflet units per degree of sky.
    // This sets the scale of the coordinate space.
    // At 2.5 arcmin FOV on a ~1000px screen, we want ~1000px per 2.5 arcmin,
    // which is 1000 / (2.5/60) = 24000 leaflet units per degree.
    // But Leaflet uses its own internal units. We'll set this so the math works
    // and adjust the zoom level to fill the screen.
    unitsPerDegree: 24000
};

// --- Location ---

function getLocation() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) {
            resolve({ lat: CONFIG.defaultLat, lon: CONFIG.defaultLon, source: 'Stonehenge (default)' });
            return;
        }

        navigator.geolocation.getCurrentPosition(
            (pos) => {
                resolve({
                    lat: pos.coords.latitude,
                    lon: pos.coords.longitude,
                    source: 'Browser geolocation'
                });
            },
            () => {
                resolve({ lat: CONFIG.defaultLat, lon: CONFIG.defaultLon, source: 'Stonehenge (default)' });
            },
            { timeout: 5000 }
        );
    });
}

// --- Coordinate Conversion ---

/**
 * Convert RA/Dec (degrees) to Leaflet map coordinates [y, x],
 * relative to a reference RA (the center of the viewport).
 *
 * The key insight: we don't use absolute RA for the X coordinate.
 * Instead, we use the *offset* from the current center RA. This keeps
 * the numbers small and avoids RA wraparound issues.
 *
 * @param {number} raDeg - RA in degrees
 * @param {number} decDeg - Dec in degrees
 * @param {number} centerRA - the current zenith RA (center of viewport)
 * @param {number} centerDec - the current zenith Dec (center of viewport)
 * @returns {{ x: number, y: number }} Leaflet-space coordinates
 */
function celestialToXY(raDeg, decDeg, centerRA, centerDec) {
    // RA offset from center. Handle wraparound.
    let dRA = raDeg - centerRA;
    if (dRA > 180) dRA -= 360;
    if (dRA < -180) dRA += 360;

    // Increasing RA maps to decreasing X (leftward on screen).
    // This matches PanSTARRS JPEG orientation (RA increases to the left).
    // As zenith RA increases over time, a fixed object's dRA decreases,
    // so -dRA increases, meaning the object moves rightward (left to right).

    const x = -dRA * CONFIG.unitsPerDegree * Math.cos(centerDec * Math.PI / 180);
    const y = (decDeg - centerDec) * CONFIG.unitsPerDegree;

    return { x, y };
}

/**
 * Clamp the displayed Dec so the viewport stays within the tile strip.
 *
 * @param {number} zenithDec - true zenith declination (= user latitude)
 * @param {number} bandDec - center declination of the tile band
 * @param {number} tileSizeDeg - tile height in degrees
 * @param {number} fovArcmin - configured FoV in arcminutes
 * @returns {number} clamped Dec in degrees
 */
function clampDec(zenithDec, bandDec, tileSizeDeg, fovArcmin) {
    // Compute the actual viewport FoV height in degrees
    let fovHeightDeg;
    if (window.innerWidth >= window.innerHeight) {
        // Landscape: height is the smaller dimension
        fovHeightDeg = (fovArcmin / 60) * (window.innerHeight / window.innerWidth);
    } else {
        // Portrait: height gets the full fovArcmin
        fovHeightDeg = fovArcmin / 60;
    }

    const maxDec = bandDec + tileSizeDeg / 2 - fovHeightDeg / 2;
    const minDec = bandDec - tileSizeDeg / 2 + fovHeightDeg / 2;

    return Math.max(minDec, Math.min(zenithDec, maxDec));
}

// --- Initialize ---

async function init() {
    const location = await getLocation();

    // Bucket user latitude to the nearest tile-size interval.
    // All users within this ~18km band share the same tile Dec row.
    const tileSizeDeg = CONFIG.tileSizeArcmin / 60;
    const bandDec = Math.round(location.lat / (CONFIG.tileSizeArcmin / 60)) * (CONFIG.tileSizeArcmin / 60);

    // Show location info
    const locEl = document.getElementById('location-info');
    locEl.textContent = `${location.source} (${location.lat.toFixed(2)}°, ${location.lon.toFixed(2)}°)`;

    // --- Set up Leaflet ---

    const map = L.map('map', {
        crs: L.CRS.Simple,
        center: [0, 0],
        zoomControl: false,
        attributionControl: false,
        // Allow deep zoom out for wide FOV
        minZoom: -10,
        maxZoom: 20,
        // Disable ALL interaction
        dragging: false,
        touchZoom: false,
        doubleClickZoom: false,
        scrollWheelZoom: false,
        boxZoom: false,
        keyboard: false,
        tap: false
    });

    // Set zoom level so that the FOV fills the viewport width.
    // CRS.Simple: pixels = units * 2^zoom.
    // We want fovInUnits * 2^zoom = viewportWidth.
    const fovInUnits = (CONFIG.fovArcmin / 60) * CONFIG.unitsPerDegree;

    function computeZoom() {
        const largerDimension = Math.max(window.innerWidth, window.innerHeight);
        return Math.log2(largerDimension / fovInUnits);
    }

    let zoom = computeZoom();
    map.setView([0, 0], zoom);

    // Re-fit zoom on window resize (also covers fullscreen toggle)
    window.addEventListener('resize', () => {
        zoom = computeZoom();
        map.setView([0, 0], zoom);
    });

    // --- Shift-click to download tiles (when frozen) ---

    // Helper: convert Leaflet coords back to RA/Dec
    function leafletToRADec(latlng, centerRA, centerDec) {
        const clickX = latlng.lng;
        const clickY = latlng.lat;
        
        // Invert the coordToXY transform
        // x = -dRA * unitsPerDegree * cos(centerDec)
        // y = dDec * unitsPerDegree
        const dRA = -clickX / (CONFIG.unitsPerDegree * Math.cos(centerDec * Math.PI / 180));
        const dDec = clickY / CONFIG.unitsPerDegree;
        
        let clickRA = centerRA + dRA;
        const clickDec = centerDec + dDec;
        
        // Normalize RA to 0-360
        clickRA = ((clickRA % 360) + 360) % 360;
        
        return { ra: clickRA, dec: clickDec };
    }
    
    // Helper: download a blob URL with a given filename
    function downloadURL(url, filename) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
    
    // Helper: build original Pan-STARRS URL for a tile
    async function getOriginalPanSTARRSURL(raDeg, decDeg) {
        // This duplicates logic from PanSTARRSImageSource, but we need the URL before processing
        const searchUrl = 'https://ps1images.stsci.edu/cgi-bin/ps1filenames.py';
        const searchParams = new URLSearchParams({ ra: raDeg, dec: decDeg });
        const searchResp = await fetch(`${searchUrl}?${searchParams}`);
        if (!searchResp.ok) throw new Error(`PanSTARRS search HTTP ${searchResp.status}`);

        const text = await searchResp.text();
        const lines = text.trim().split('\n');
        const header = lines[0].split(/\s+/);
        const filterIdx = header.indexOf('filter');
        const filenameIdx = header.indexOf('filename');

        if (filterIdx === -1 || filenameIdx === -1) {
            throw new Error('PanSTARRS: unexpected header format');
        }

        const filterFiles = {};
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(/\s+/);
            if (cols.length >= header.length) {
                filterFiles[cols[filterIdx]] = cols[filenameIdx];
            }
        }

        for (const f of ['g', 'r', 'i']) {
            if (!filterFiles[f]) throw new Error(`PanSTARRS: missing ${f} filter`);
        }

        const basename = (path) => path.split('/').pop();
        const cutoutUrl = 'https://ps1images.stsci.edu/cgi-bin/fitscut.cgi';
        
        const tilePixelsDec = Math.round(CONFIG.tileSizeArcmin * 60 / 0.25);
        const tilePixelsRA  = Math.round(tilePixelsDec * Math.cos(decDeg * Math.PI / 180));

        const cutoutParams = new URLSearchParams({
            ra: raDeg,
            dec: decDeg,
            size: `${tilePixelsRA},${tilePixelsDec}`,
            format: 'jpeg',
            red: basename(filterFiles['i']),
            green: basename(filterFiles['r']),
            blue: basename(filterFiles['g'])
        });

        return `${cutoutUrl}?${cutoutParams}`;
    }

    // --- Set up components ---

    const hud = new HUD();
    hud.setLatitude(location.lat);

    // Coordinate conversion helper that closes over current zenith
    let currentRA = 0;
    let currentDec = 0;

    function coordToXY(raDeg, decDeg) {
        return celestialToXY(raDeg, decDeg, currentRA, currentDec);
    }

    // Apply tile size config
    setTileSizeArcmin(CONFIG.tileSizeArcmin);

    // Image layer goes first (renders behind grid and labels)
    const imageSource = new PanSTARRSImageSource('images/stub_tile.jpg');
    const imageLayer = new ImageLayer(map, CONFIG.fovArcmin, imageSource);

    const grid = new GridLayer(map, CONFIG.fovArcmin, CONFIG.gridSpacingArcmin);

    const labels = new LabelLayer(map, CONFIG.fovArcmin);

    const simbad = new SimbadClient(CONFIG.fovArcmin, CONFIG.simbadMagnitudeLimit);

    const highlights = new Highlights(CONFIG.fovArcmin, CONFIG.highlightCount);

    // --- Shift-click handler for tile download (when frozen) ---
    
    map.on('click', async (e) => {
        // Only handle shift-clicks when frozen
        if (!clock.isFrozen()) return;
        if (!e.originalEvent.shiftKey) return;
        
        // Convert click position to RA/Dec
        const coords = leafletToRADec(e.latlng, currentRA, currentDec);
        
        console.log(`Shift-click at RA=${coords.ra.toFixed(4)}° Dec=${coords.dec.toFixed(4)}°`);
        
        // Find the tile containing this coordinate
        const tile = imageLayer.getTileAtCoords(coords.ra, coords.dec);
        
        if (!tile) {
            console.warn('No tile found at clicked position');
            return;
        }
        
        console.log(`Found tile: RA=${tile.raDeg.toFixed(4)}° Dec=${tile.decDeg.toFixed(4)}°`);
        
        try {
            // Download original
            console.log('Fetching original Pan-STARRS tile...');
            const originalUrl = await getOriginalPanSTARRSURL(tile.raDeg, tile.decDeg);
            const originalResp = await fetch(originalUrl);
            const originalBlob = await originalResp.blob();
            const originalBlobUrl = URL.createObjectURL(originalBlob);
            
            const raStr = tile.raDeg.toFixed(2).replace('.', '_');
            const decStr = tile.decDeg.toFixed(2).replace('.', '_').replace('-', 'neg');
            
            downloadURL(originalBlobUrl, `tile_ra${raStr}_dec${decStr}_original.jpg`);
            console.log('Original tile downloaded');

            // Wait briefly so the browser registers the first download
            // before we trigger the second one — browsers drop near-simultaneous
            // programmatic downloads.
            await new Promise(r => setTimeout(r, 500));

            // Download processed (extract from the overlay's src)
            const processedUrl = tile.overlay._url; // Leaflet stores the URL here
            const processedResp = await fetch(processedUrl);
            const processedBlob = await processedResp.blob();
            const processedBlobUrl = URL.createObjectURL(processedBlob);

            downloadURL(processedBlobUrl, `tile_ra${raStr}_dec${decStr}_processed.jpg`);
            console.log('Processed tile downloaded');
            
            // Clean up blob URLs
            setTimeout(() => {
                URL.revokeObjectURL(originalBlobUrl);
                URL.revokeObjectURL(processedBlobUrl);
            }, 1000);
            
        } catch (err) {
            console.error('Tile download failed:', err);
        }
    });

    // --- Controls ---

    const fullscreenBtn = document.getElementById('btn-fullscreen');
    fullscreenBtn.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {});
        } else {
            document.exitFullscreen();
        }
    });

    // Update button text on fullscreen change
    document.addEventListener('fullscreenchange', () => {
        fullscreenBtn.textContent = document.fullscreenElement ? 'exit fullscreen' : 'fullscreen';
    });

    const infoBtn = document.getElementById('btn-info');
    infoBtn.addEventListener('click', () => {
    window.open("/zenith-tech")
    });

    // Freeze checkbox (hidden unless showFreeze is true)
//     const freezeCheckbox = document.getElementById('chk-freeze');
//     const freezeLabel = freezeCheckbox.closest('label');
//     if (CONFIG.showFreeze) {
//         freezeCheckbox.addEventListener('change', () => {
//             if (freezeCheckbox.checked) {
//                 clock.freeze();
//             } else {
//                 clock.unfreeze();
//             }
//         });
//     } else {
//         freezeLabel.style.display = 'none';
//     }

    // Developer diagnostic: jump to 30 seconds before next highlight.
    const jumpHighlightBtn = document.getElementById('btn-jump-highlight');

    // --- Info panel ---
    // DOM lookups are deferred to first use, so the panel element
    // doesn't need to exist at the time this code is evaluated.

    let _infoPanel = null, _infoTitle = null, _infoSubtitle = null, _infoText = null;
    let infoPanelFadeTimer = null;

    function _ensureInfoPanel() {
        if (!_infoPanel) {
            _infoPanel = document.getElementById('info-panel');
            if (!_infoPanel) {
                console.error('info-panel element not found in DOM');
                return false;
            }
            _infoTitle = _infoPanel.querySelector('.info-title');
            _infoSubtitle = _infoPanel.querySelector('.info-subtitle');
            _infoText = _infoPanel.querySelector('.info-text');
        }
        return true;
    }

    /**
     * Show the info panel with the given content. Cancels any pending fade-out.
     * @param {string} titleText - primary line (large)
     * @param {string} subtitleText - secondary line (medium, dimmer)
     * @param {string} infoTextContent - detail line (small, dimmest)
     */
    function showInfoPanel(titleText, subtitleText, infoTextContent) {
        if (!_ensureInfoPanel()) return;
        if (infoPanelFadeTimer) {
            clearTimeout(infoPanelFadeTimer);
            infoPanelFadeTimer = null;
        }
        _infoTitle.textContent = titleText;
        _infoSubtitle.textContent = subtitleText;
        _infoText.innerHTML = infoTextContent;

        // Reset transition state and fade in
        _infoPanel.classList.remove('fade-out');
        void _infoPanel.offsetWidth; // force reflow
        _infoPanel.classList.add('visible');
    }

    /**
     * Fade out the info panel over 2 seconds, then hide it.
     */
    function hideInfoPanel() {
        if (!_ensureInfoPanel()) return;
        if (infoPanelFadeTimer) {
            clearTimeout(infoPanelFadeTimer);
            infoPanelFadeTimer = null;
        }
        _infoPanel.classList.add('fade-out');
        infoPanelFadeTimer = setTimeout(() => {
            _infoPanel.classList.remove('visible', 'fade-out');
            infoPanelFadeTimer = null;
        }, 2000);
    }

    // --- Highlight countdown display ---

    /**
     * Show the next upcoming highlight in the info panel with its ETA.
     */
    function showNextHighlight(ra) {
        const next = highlights.getNextUpcoming(ra);
        if (!next) return;

        const { obj, etaSec } = next;
        const title = `Next Highlight: ${obj.name}`;
        const subtitle = (obj.type || '')
            + (obj.mag != null ? `  V=${obj.mag.toFixed(1)}` : '');
        const eta = Highlights.formatETA(etaSec);
        const info = `RA ${formatRA(obj.ra)}  Dec ${formatDec(obj.dec)}<br>arriving in ${eta}`;

        showInfoPanel(title, subtitle, info);
    }

    /**
     * Show a highlight that is currently in the FoV.
     */
    function showVisibleHighlight(obj) {
        const title = `Highlight ${obj.name}`;
        const subtitle = (obj.type || '')
            + (obj.mag != null ? `  V=${obj.mag.toFixed(1)}` : '');
        const info = `RA ${formatRA(obj.ra)}  Dec ${formatDec(obj.dec)}<br>Now Visible`;
        showInfoPanel(title, subtitle, info);
    }

    /**
     * Render highlight panel content for the current RA.
     */
    function renderHighlightPanel(ra) {
        const display = highlights.getDisplay(ra);
        if (!display) return;
        if (display.mode === 'visible') {
            showVisibleHighlight(display.obj);
        } else {
            showNextHighlight(ra);
        }
    }

    /**
     * Compute current center coordinates for a given time.
     * Honors diagnostic coordinate lock.
     */
    function getCenterForTime(now) {
        if (CONFIG.diagnostic_coordinate_lock) {
            return {
                ra: CONFIG.diagnostic_coordinate_lock.ra,
                dec: CONFIG.diagnostic_coordinate_lock.dec
            };
        }
        const zenith = zenithPosition(now, location.lat, location.lon);
        return {
            ra: zenith.ra,
            dec: clampDec(zenith.dec, bandDec, tileSizeDeg, CONFIG.fovArcmin)
        };
    }

    // --- Loading indicator ---

    const loadingEl = document.getElementById('hud-loading');
    let wasLoading = true; // start visible

    // Startup overlay — dismissed once the first image tile arrives
    const loadingOverlay = document.getElementById('loading-overlay');
    let startupDone = false;

    // --- Clock ---

    const clock = new Clock(CONFIG.hudUpdateMs, CONFIG.timeOffsetMinutes);

    /**
     * Dynamically set simulated time offset (minutes) without restarting.
     * Intended for debugging and QC workflows.
     */
    function setTimeOffsetMinutes(minutes) {
        const parsed = Number(minutes);
        if (!Number.isFinite(parsed)) {
            console.warn('setTimeOffsetMinutes: expected a finite number, got', minutes);
            return;
        }

        CONFIG.timeOffsetMinutes = parsed;
        clock.setOffsetMinutes(parsed);

        // Time jump invalidates caches and transient announcement state.
        imageLayer.clearTiles();
        simbad.reset();
        highlights.resetState();

        const now = clock.getNow();
        const center = getCenterForTime(now);
        currentRA = center.ra;
        currentDec = center.dec;

        grid.update(currentRA, currentDec, coordToXY);
        labels.update(currentRA, currentDec, simbad.getObjects(), coordToXY, CONFIG.diagnostic);
        hud.update(now, currentRA, currentDec, 0, CONFIG.fovArcmin);
        hideInfoPanel();
        renderHighlightPanel(currentRA);

        // Immediately repopulate data at the new simulated time.
        const queryRA = CONFIG.diagnostic_coordinate_lock
            ? currentRA - simbad.prefetchAheadDeg
            : currentRA;
        simbad.update(queryRA, currentDec).catch(err => {
            console.warn('SIMBAD update error after time offset change:', err);
        });

        loadingEl.style.display = '';
        wasLoading = true;

        console.log(`Time offset set to ${parsed} min (simulated UTC ${now.toISOString().substring(11, 19)})`);
    }

    // Dev console API:
    //   window.zenithTrack.setTimeOffsetMinutes(240)
    //   window.zenithTrack.getTimeOffsetMinutes()
    window.zenithTrack = {
        ...(window.zenithTrack || {}),
        setTimeOffsetMinutes,
        getTimeOffsetMinutes: () => clock.getOffsetMinutes()
    };

    if (jumpHighlightBtn) {
        jumpHighlightBtn.addEventListener('click', () => {
            const next = highlights.getNextUpcoming(currentRA);
            if (!next) {
                console.warn('No upcoming highlight available for jump');
                return;
            }

            const jumpSec = next.etaSec - 30;
            const newOffsetMin = clock.getOffsetMinutes() + (jumpSec / 60);
            setTimeOffsetMinutes(newOffsetMin);
            console.log(`Jumped to T-00:30 before ${next.obj.name}`);
        });
    }

    // Frame callback: update all layer positions
    clock.onFrame((now) => {
        const center = getCenterForTime(now);
        currentRA = center.ra;
        currentDec = center.dec;

        // Update image tiles (repositions, requests new tiles as needed)
        imageLayer.update(currentRA, currentDec, coordToXY, CONFIG.diagnostic);

        // Update grid (redraws lines at new positions)
        grid.update(currentRA, currentDec, coordToXY);

        // Update label positions (uses cached SIMBAD objects)
        labels.update(currentRA, currentDec, simbad.getObjects(), coordToXY, CONFIG.diagnostic);

        // Update loading indicator (only touch DOM on state change)
        const isLoading = imageLayer.getPendingCount() > 0;
        if (isLoading !== wasLoading) {
            loadingEl.style.display = isLoading ? '' : 'none';
            wasLoading = isLoading;
        }

        // Dismiss startup overlay once first tiles have actually arrived
        if (!startupDone && imageLayer.getLoadedCount() > 0) {
            startupDone = true;
            loadingOverlay.classList.add('fade-out');
            loadingOverlay.addEventListener('transitionend', () => {
                loadingOverlay.remove();
            });
        }
    });

    // Tick callback: update HUD and trigger SIMBAD queries (once per second)
    clock.onTick((now) => {
        const center = getCenterForTime(now);
        const ra = center.ra;
        const dec = center.dec;
        hud.update(now, ra, dec, simbad.getObjectCount(), CONFIG.fovArcmin);

        if (CONFIG.downloadMetrics) {
            hud.updateDownloadMetrics(imageLayer.getDownloadMetrics());
        }

        // Trigger SIMBAD query. When coordinate-locked, offset RA backward
        // so the internal +prefetchAheadDeg lands on the locked center.
        const queryRA = CONFIG.diagnostic_coordinate_lock
            ? ra - simbad.prefetchAheadDeg
            : ra;
        simbad.update(queryRA, dec).catch(err => {
            console.warn('SIMBAD update error:', err);
        });

        renderHighlightPanel(ra);
    });

    // Fire one immediate update so the screen isn't blank
    const now = clock.getNow();
    const center = getCenterForTime(now);
    currentRA = center.ra;
    currentDec = center.dec;
    if (CONFIG.diagnostic_coordinate_lock) {
        console.log(`DIAGNOSTIC LOCK: RA=${currentRA.toFixed(4)}° Dec=${currentDec.toFixed(4)}° (no panning)`);
    }
    grid.update(currentRA, currentDec, coordToXY);
    hud.update(now, currentRA, currentDec, 0, CONFIG.fovArcmin);

    // Initial SIMBAD query
    const initQueryRA = CONFIG.diagnostic_coordinate_lock
        ? currentRA - simbad.prefetchAheadDeg
        : currentRA;
    simbad.update(initQueryRA, currentDec);

    // Load highlights for this latitude, then show the first upcoming one
    // and tell the label layer which names to boost
    highlights.load(location.lat).then(() => {
        labels.setHighlightNames(highlights.getNames());
        renderHighlightPanel(currentRA);
    }).catch(err => {
        console.warn('Highlights query failed:', err);
    });

    // Start
    clock.start();

    console.log('ZenithTrack running');
    console.log(`Location: ${location.source} (${location.lat.toFixed(4)}°, ${location.lon.toFixed(4)}°)`);
    console.log(`FOV: ${CONFIG.fovArcmin} arcmin, Grid: ${CONFIG.gridSpacingArcmin} arcmin`);
}

init();
