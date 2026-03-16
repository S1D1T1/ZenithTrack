/**
 * image-layer.js - Sky Image Tile Layer
 *
 * Displays sky images (JPEGs) as Leaflet image overlays, positioned by RA/Dec.
 * Images are tiled edge-to-edge along the RA axis, covering the viewport
 * plus a buffer for prefetch.
 *
 * Like grid and labels, images drift leftward as the zenith RA advances.
 * The viewport is fixed; we reposition the image overlays each frame.
 *
 * Tile management:
 *   - Each tile covers TILE_SIZE_ARCMIN x TILE_SIZE_ARCMIN of sky
 *   - Tiles are identified by their center RA/Dec (snapped to grid)
 *   - New tiles are requested ahead of the viewport
 *   - Old tiles that have scrolled off are removed
 *   - Image fetching is async; tiles appear when ready
 */

import { TILE_SIZE_ARCMIN } from './image-source.js';

// How many extra tile-widths ahead of the FOV edge to prefetch
const PREFETCH_EXTRA = 0;

// How many extra tile-widths behind the FOV edge to keep before evicting
const KEEP_EXTRA = 1;

export class ImageLayer {
    /**
     * @param {L.Map} map - the Leaflet map instance
     * @param {number} fovArcmin - field of view in arcminutes
     * @param {object} imageSource - an object with getImageUrl(ra, dec) -> Promise<string>
     */
    constructor(map, fovArcmin, imageSource) {
        this.map = map;
        this.fov = fovArcmin;
        this.imageSource = imageSource;
        this.layerGroup = L.layerGroup().addTo(map);

        // Diagnostic label layer (rendered on top of images)
        this.diagLayerGroup = L.layerGroup();

        // Tile size in degrees
        this.tileSizeDeg = TILE_SIZE_ARCMIN / 60.0;

        // Active tiles: Map of tileKey -> { raDeg, decDeg, overlay, loading }
        this.tiles = new Map();

        // In-flight requests: Set of tileKeys currently being fetched
        this.pending = new Set();

        // Startup flag: on the very first update, skip the trailing (western)
        // tile column. Those tiles have the lowest RA and will have nearly
        // scrolled off by the time they finish loading, wasting bandwidth
        // and delaying the tiles the user actually sees.
        this._firstUpdate = true;
    }

    /**
     * Compute a tile key from a tile grid index.
     * Using integer indices avoids floating point drift in keys.
     */
    _tileKey(raIndex, decIndex) {
        return `${raIndex}_${decIndex}`;
    }

    /**
     * Snap an RA value to the nearest tile grid index.
     */
    _snapRAIndex(raDeg) {
        return Math.round(raDeg / this.tileSizeDeg);
    }

    /**
     * Snap a Dec value to the nearest tile grid index.
     */
    _snapDecIndex(decDeg) {
        return Math.round(decDeg / this.tileSizeDeg);
    }

    /**
     * Convert a tile grid index back to degrees.
     */
    _indexToDeg(index) {
        return index * this.tileSizeDeg;
    }

    /**
     * Update tile positions and request new tiles as needed.
     * Called every animation frame for repositioning,
     * but tile fetching only happens when new tiles are needed.
     *
     * @param {number} centerRA - current zenith RA in degrees
     * @param {number} centerDec - current zenith Dec in degrees
     * @param {function} coordToXY - converts (raDeg, decDeg) to {x, y}
     */
    update(centerRA, centerDec, coordToXY, diagnostic = false) {
        const halfTile = this.tileSizeDeg / 2;

        // Determine how many tiles span the FOV in each axis
        const tilesAcross = Math.ceil(this.fov / TILE_SIZE_ARCMIN);

        // RA range: half the FOV behind center, half ahead, plus buffers
        const halfRA = Math.ceil(tilesAcross / 2);
        // On the very first update, skip the trailing (western) tiles — they'll
        // have scrolled off by the time they load. After that, use the normal
        // range so tiles that drift west are already cached.
        let startOffset;
        if (this._firstUpdate) {
            startOffset = -(halfRA - 1);
            this._firstUpdate = false;
        } else {
            startOffset = -(halfRA + KEEP_EXTRA);
        }
        const endOffset = halfRA + PREFETCH_EXTRA;

        // Snap center to tile grid using integer indices
        const centerRAIdx = this._snapRAIndex(centerRA);
        const centerDecIdx = this._snapDecIndex(centerDec);

        // Single Dec row: only fetch tiles at the band center Dec index.
        // The displayed Dec is already clamped to stay within this tile row.
        const decIndices = [centerDecIdx];

        // Collect which tiles should exist
        const neededKeys = new Set();

        for (let i = startOffset; i <= endOffset; i++) {
            const raIdx = centerRAIdx + i;

            for (const decIdx of decIndices) {
                const key = this._tileKey(raIdx, decIdx);
                neededKeys.add(key);

                // Request tile if we don't have it and aren't already fetching
                if (!this.tiles.has(key) && !this.pending.has(key)) {
                    // Convert index to degrees for the API request
                    let raDeg = this._indexToDeg(raIdx);
                    // Normalize RA to 0-360 for the API
                    raDeg = ((raDeg % 360) + 360) % 360;
                    const decDeg = this._indexToDeg(decIdx);

                    this._requestTile(raDeg, decDeg, key);
                }
            }
        }

        // Evict tiles we no longer need
        for (const [key, tile] of this.tiles) {
            if (!neededKeys.has(key)) {
                this.layerGroup.removeLayer(tile.overlay);
                this.tiles.delete(key);
            }
        }

        // Reposition all active tiles
        this.diagLayerGroup.clearLayers();

        for (const [key, tile] of this.tiles) {
            // coordToXY maps increasing RA to decreasing X (leftward),
            // matching PanSTARRS JPEG orientation. No image flip needed.
            // Low RA → high X (right on screen), High RA → low X (left on screen).
            // L.latLngBounds internally sorts to find actual SW/NE by min/max.
            const lowRA = coordToXY(tile.raDeg - halfTile, tile.decDeg - halfTile);
            const highRA = coordToXY(tile.raDeg + halfTile, tile.decDeg + halfTile);

            const bounds = L.latLngBounds(
                [lowRA.y, lowRA.x],
                [highRA.y, highRA.x]
            );

            tile.overlay.setBounds(bounds);

            // Diagnostic: bounds logging + border + label
            if (diagnostic) {
                // Log bounds for first tile only (once)
                if (!this._boundsLogged) {
                    const sw = bounds.getSouthWest();
                    const ne = bounds.getNorthEast();
                    const dLng = Math.abs(ne.lng - sw.lng);
                    const dLat = Math.abs(ne.lat - sw.lat);
                    console.log(`Tile bounds check: tile RA=${tile.raDeg.toFixed(4)}° Dec=${tile.decDeg.toFixed(4)}°`);
                    console.log(`  SW(lat=${sw.lat.toFixed(2)}, lng=${sw.lng.toFixed(2)}) NE(lat=${ne.lat.toFixed(2)}, lng=${ne.lng.toFixed(2)})`);
                    console.log(`  Span: ${dLng.toFixed(2)} × ${dLat.toFixed(2)} leaflet units (tileSizeDeg=${this.tileSizeDeg.toFixed(5)}°)`);
                    this._boundsLogged = true;
                }
                // White border rectangle around the tile
                const borderRect = L.rectangle(bounds, {
                    color: '#ffffff',
                    weight: 1,
                    opacity: 0.5,
                    fill: false,
                    interactive: false
                });
                this.diagLayerGroup.addLayer(borderRect);

                const topLeftScreen = coordToXY(tile.raDeg + halfTile, tile.decDeg + halfTile);
                const diagLabel = L.marker([topLeftScreen.y, topLeftScreen.x], {
                    icon: L.divIcon({
                        className: 'tile-diag-label',
                        html: `<span style="font-size:10px;font-family:monospace;color:rgba(0,255,180,0.5);white-space:nowrap;background:rgba(0,0,0,0.5);padding:1px 3px;">`
                            + `tile center RA ${tile.raDeg.toFixed(5)}° Dec ${tile.decDeg.toFixed(5)}°`
                            + `<br>bounds RA ${(tile.raDeg - halfTile).toFixed(5)}–${(tile.raDeg + halfTile).toFixed(5)}°`
                            + `</span>`,
                        iconAnchor: [0, 0]
                    }),
                    interactive: false
                });
                this.diagLayerGroup.addLayer(diagLabel);
            }
        }

        // Show/hide diagnostic layer
        if (diagnostic && !this.map.hasLayer(this.diagLayerGroup)) {
            this.map.addLayer(this.diagLayerGroup);
        } else if (!diagnostic && this.map.hasLayer(this.diagLayerGroup)) {
            this.map.removeLayer(this.diagLayerGroup);
        }
    }

    /** @private */
    async _requestTile(raDeg, decDeg, key) {
        this.pending.add(key);

        try {
            const url = await this.imageSource.getImageUrl(raDeg, decDeg);

            // Tile might have been evicted while we were fetching
            if (!this.pending.has(key)) return;

            // Create image overlay with temporary bounds (will be set in update)
            const overlay = L.imageOverlay(url, [[0, 0], [0, 0]], {
                opacity: 0.85,
                interactive: false
            });

            this.layerGroup.addLayer(overlay);

            this.tiles.set(key, {
                raDeg,
                decDeg,
                overlay
            });
        } catch (err) {
            console.warn(`Image tile fetch failed for RA=${raDeg.toFixed(3)} Dec=${decDeg.toFixed(3)}:`, err.message);
        } finally {
            this.pending.delete(key);
        }
    }

    /** Download metrics from the image source (if supported) */
    getDownloadMetrics() {
        return this.imageSource.getDownloadMetrics?.() ?? null;
    }

    /** Number of tiles currently being fetched */
    getPendingCount() {
        return this.pending.size;
    }

    /** Number of tiles that have loaded and are on screen */
    getLoadedCount() {
        return this.tiles.size;
    }

    /**
     * Update field of view. Clears all tiles and re-fetches at new size.
     * @param {number} fovArcmin - new field of view in arcminutes
     */
    setFOV(fovArcmin) {
        this.fov = fovArcmin;
        // TILE_SIZE_ARCMIN was already updated by setTileSizeArcmin() in image-source.js
        this.tileSizeDeg = TILE_SIZE_ARCMIN / 60.0;
        this.clearTiles();
        this._firstUpdate = true;
    }

    /** Clear all tiles, forcing re-fetch on next update */
    clearTiles() {
        this.layerGroup.clearLayers();
        this.tiles.clear();
        this.pending.clear();
    }

    /** Show/hide the image layer */
    setVisible(visible) {
        if (visible) {
            this.map.addLayer(this.layerGroup);
        } else {
            this.map.removeLayer(this.layerGroup);
        }
    }

    /** Check visibility */
    isVisible() {
        return this.map.hasLayer(this.layerGroup);
    }

    /** Toggle visibility */
    toggle() {
        this.setVisible(!this.isVisible());
    }

    /**
     * Find the tile containing the given RA/Dec coordinates.
     * Returns tile info or null if no tile is loaded at that position.
     * 
     * @param {number} raDeg - RA in degrees
     * @param {number} decDeg - Dec in degrees
     * @returns {{ raDeg: number, decDeg: number, overlay: L.ImageOverlay, key: string } | null}
     */
    getTileAtCoords(raDeg, decDeg) {
        // Normalize RA to 0-360
        raDeg = ((raDeg % 360) + 360) % 360;
        
        // Snap to tile grid
        const raIdx = this._snapRAIndex(raDeg);
        const decIdx = this._snapDecIndex(decDeg);
        const key = this._tileKey(raIdx, decIdx);
        
        const tile = this.tiles.get(key);
        if (!tile) return null;
        
        return {
            raDeg: tile.raDeg,
            decDeg: tile.decDeg,
            overlay: tile.overlay,
            key: key
        };
    }
}
