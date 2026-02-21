/**
 * labels.js - SIMBAD Object Label Layer
 *
 * Renders astronomical objects as crosshair markers with name labels
 * on the Leaflet map. Objects are positioned using the same coordToXY
 * conversion as the grid, so they drift left in sync with everything else.
 *
 * Like the grid, this is a Leaflet layer group that can be toggled.
 */

// --- Configurable label style ---

const LABEL_CONFIG = {
    // Crosshair marker
    crossSize: 4,           // half-length of each arm in pixels
    crossAlpha: 0.8,        // peak alpha for crosshair (faded at edges)
    crossWeight: 1.5,

    // Text label
    fontSize: 16,           // px
    fontAlpha: 0.8,         // peak alpha for text (faded at edges)
    fontFamily: "'Courier New', monospace",
    labelOffsetX: 14,       // px right of crosshair
    labelOffsetY: -2,       // px up from crosshair center

    // --- Highlight labels (objects in the highlights list) ---
    highlightFontSize: 20,          // px (+4 over normal)
    highlightFontWeight: 'bold',    // bold | normal
    highlightColor: [100, 220, 210] // rgb teal (matches info-panel title)
};

export class LabelLayer {
    /**
     * @param {L.Map} map - the Leaflet map instance
     * @param {number} fovArcmin - field of view in arcminutes (used to set render radius)
     */
    constructor(map, fovArcmin) {
        this.map = map;
        this.layerGroup = L.layerGroup().addTo(map);
        // Render objects within FOV + 50% buffer on each side
        this.renderRadiusDeg = (fovArcmin / 60) * 1.5;
        // Set of highlight object names (for boosted styling)
        this.highlightNames = new Set();
    }

    /**
     * Update field of view (adjusts label render radius).
     * @param {number} fovArcmin - new field of view in arcminutes
     */
    setFOV(fovArcmin) {
        this.renderRadiusDeg = (fovArcmin / 60) * 1.5;
    }

    /**
     * Set which object names should be rendered as highlights.
     * @param {Set<string>} names
     */
    setHighlightNames(names) {
        this.highlightNames = names;
    }

    /**
     * Update label positions given current zenith and object list.
     * Called every animation frame.
     *
     * @param {number} centerRA - current center RA in degrees
     * @param {number} centerDec - current center Dec in degrees
     * @param {Array<{name, type, ra, dec}>} objects - from SimbadClient
     * @param {function} coordToXY - converts (raDeg, decDeg) to {x, y}
     */
    /**
     * Compute fade alpha based on screen-space horizontal position.
     * Fade in over the leftmost 20% (objects entering from left),
     * full brightness in the middle 60%,
     * fade out over the rightmost 20% (objects exiting right).
     *
     * @param {number} screenX - pixel X from left edge
     * @param {number} maxAlpha - the peak alpha (from CSS, e.g. 0.4)
     * @returns {number} alpha value 0..maxAlpha
     */
    _fadeAlpha(screenX, maxAlpha) {
        const w = window.innerWidth;
        const fadeZone = w * 0.2;

        if (screenX > w - fadeZone) {
            // Right edge fade-out (exiting right)
            return maxAlpha * (w - screenX) / fadeZone;
        } else if (screenX < fadeZone) {
            // Left edge fade-in (entering from left)
            return maxAlpha * screenX / fadeZone;
        }
        return maxAlpha;
    }

    update(centerRA, centerDec, objects, coordToXY, diagnostic = false) {
        this.layerGroup.clearLayers();

        const s = LABEL_CONFIG.crossSize;
        const mapSize = this.map.getSize();

        for (const obj of objects) {
            // Check if object is close enough to render
            let dRA = obj.ra - centerRA;
            if (dRA > 180) dRA -= 360;
            if (dRA < -180) dRA += 360;
            const dDec = obj.dec - centerDec;

            if (Math.abs(dRA) > this.renderRadiusDeg || Math.abs(dDec) > this.renderRadiusDeg) {
                continue;
            }

            const pos = coordToXY(obj.ra, obj.dec);

            // Convert map coords to screen pixel X for fade calculation
            const screenPt = this.map.latLngToContainerPoint([pos.y, pos.x]);
            const alpha = this._fadeAlpha(screenPt.x, LABEL_CONFIG.crossAlpha);
            const textAlpha = this._fadeAlpha(screenPt.x, LABEL_CONFIG.fontAlpha);

            if (alpha < 0.01) continue; // fully faded, skip rendering

            // Crosshair marker using a divIcon with inline SVG
            const crossSize = s * 2 + 1;
            const crossColor = `rgba(255, 220, 80, ${alpha.toFixed(3)})`;
            const crossHtml = `<svg width="${crossSize}" height="${crossSize}" style="overflow:visible">` +
                `<line x1="${s}" y1="0" x2="${s}" y2="${crossSize}" stroke="${crossColor}" stroke-width="${LABEL_CONFIG.crossWeight}"/>` +
                `<line x1="0" y1="${s}" x2="${crossSize}" y2="${s}" stroke="${crossColor}" stroke-width="${LABEL_CONFIG.crossWeight}"/>` +
                `</svg>`;

            const marker = L.marker([pos.y, pos.x], {
                icon: L.divIcon({
                    className: 'simbad-crosshair',
                    html: crossHtml,
                    iconSize: [crossSize, crossSize],
                    iconAnchor: [s, s]  // center on the coordinate
                }),
                interactive: false
            });
            this.layerGroup.addLayer(marker);

            // Text label — highlights get boosted size and teal color
            const isHighlight = this.highlightNames.has(obj.name);
            const [cr, cg, cb] = isHighlight
                ? LABEL_CONFIG.highlightColor
                : [180, 200, 255];
            const fontSize = isHighlight
                ? LABEL_CONFIG.highlightFontSize
                : LABEL_CONFIG.fontSize;
            const fontColor = `rgba(${cr}, ${cg}, ${cb}, ${textAlpha.toFixed(3)})`;
            let labelText = obj.name;
            if (diagnostic) {
                labelText += `<br><span style="font-size:10px;color:rgba(${cr},${cg},${cb},${(textAlpha * 0.9).toFixed(3)})">`
                    + `RA ${obj.ra.toFixed(5)}° Dec ${obj.dec.toFixed(5)}°</span>`;
            }
            const fontWeight = isHighlight ? LABEL_CONFIG.highlightFontWeight : 'normal';
            const bgAlpha = (textAlpha * 0.6).toFixed(3);
            const spanStyle = `style="font-size:${fontSize}px;font-weight:${fontWeight};color:${fontColor};background:rgba(0,0,0,${bgAlpha});padding:1px 4px;border-radius:2px"`;
            const label = L.marker([pos.y, pos.x], {
                icon: L.divIcon({
                    className: 'simbad-label',
                    html: `<span ${spanStyle}>${labelText}</span>`,
                    iconAnchor: [-LABEL_CONFIG.labelOffsetX, LABEL_CONFIG.labelOffsetY]
                }),
                interactive: false
            });
            this.layerGroup.addLayer(label);
        }
    }

    /** Show/hide the labels */
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
}
