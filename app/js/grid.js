/**
 * grid.js - Coordinate Grid Layer
 *
 * Draws a faint coordinate grid on the Leaflet map.
 * Gridlines are spaced at a configurable interval (default 0.5 arcmin).
 * Lines are positioned in RA/Dec space and drift leftward as time advances.
 *
 * The grid extends beyond the visible viewport to ensure smooth scrolling.
 * Lines that scroll off the left edge are removed; new lines are added
 * on the right as needed.
 *
 * This is a Leaflet layer group that can be toggled on/off.
 */

// Default grid spacing in arcminutes
const DEFAULT_SPACING_ARCMIN = 0.5;

// Buffer is now derived from FOV in the constructor (see below)

// Grid line style
const GRID_STYLE = {
    color: 'rgba(80, 120, 200, 0.15)',
    weight: 1,
    interactive: false
};

const GRID_STYLE_MAJOR = {
    color: 'rgba(80, 120, 200, 0.25)',
    weight: 1,
    interactive: false
};

export class GridLayer {
    /**
     * @param {L.Map} map - the Leaflet map instance
     * @param {number} fovArcmin - field of view height/width in arcminutes
     * @param {number} spacingArcmin - grid spacing in arcminutes
     */
    constructor(map, fovArcmin, spacingArcmin = DEFAULT_SPACING_ARCMIN) {
        this.map = map;
        this.fov = fovArcmin;
        this.spacing = spacingArcmin;
        // Buffer: FOV + 50% margin on each side to cover the full viewport
        // plus some extra for non-square screens
        this.bufferArcmin = fovArcmin * 1.0;
        this.layerGroup = L.layerGroup().addTo(map);
        this.raLines = [];  // { raDeg, line }
        this.decLines = []; // { decDeg, line }
    }

    /**
     * Update field of view and adapt grid spacing.
     * @param {number} fovArcmin - new field of view in arcminutes
     */
    setFOV(fovArcmin) {
        this.fov = fovArcmin;
        this.bufferArcmin = fovArcmin * 1.0;
        // Scale grid spacing to avoid overdraw at wide FOV
        if (fovArcmin <= 12.5)     this.spacing = 0.5;
        else if (fovArcmin <= 25)  this.spacing = 1.0;
        else if (fovArcmin <= 50)  this.spacing = 2.0;
        else                       this.spacing = 2.5;
    }

    /**
     * Update grid positions given current zenith.
     * Called every animation frame.
     *
     * @param {number} centerRA - current center RA in degrees
     * @param {number} centerDec - current center Dec in degrees
     * @param {function} coordToXY - converts {ra, dec} in degrees to Leaflet {x, y}
     */
    update(centerRA, centerDec, coordToXY) {
        const spacingDeg = this.spacing / 60.0; // arcmin to degrees
        const bufferDeg = this.bufferArcmin / 60.0;

        // Clear existing lines
        this.layerGroup.clearLayers();

        // RA range to draw (centerRA +/- buffer)
        const raMin = centerRA - bufferDeg;
        const raMax = centerRA + bufferDeg;

        // Dec range to draw
        const decMin = centerDec - bufferDeg;
        const decMax = centerDec + bufferDeg;

        // Snap to grid
        const raStart = Math.floor(raMin / spacingDeg) * spacingDeg;
        const decStart = Math.floor(decMin / spacingDeg) * spacingDeg;

        // Vertical lines (constant RA)
        for (let ra = raStart; ra <= raMax; ra += spacingDeg) {
            const topPt = coordToXY(ra, decMax);
            const botPt = coordToXY(ra, decMin);

            // Major line every 5 grid spacings (every 2.5 arcmin)
            const isMajor = Math.abs(ra / spacingDeg - Math.round(ra / spacingDeg) * 5) < 0.001
                && Math.abs((ra / spacingDeg) % 5) < 0.001;

            const line = L.polyline(
                [[topPt.y, topPt.x], [botPt.y, botPt.x]],
                isMajor ? GRID_STYLE_MAJOR : GRID_STYLE
            );
            this.layerGroup.addLayer(line);
        }

        // Horizontal lines (constant Dec)
        for (let dec = decStart; dec <= decMax; dec += spacingDeg) {
            const leftPt = coordToXY(raMin, dec);
            const rightPt = coordToXY(raMax, dec);

            const isMajor = Math.abs((dec / spacingDeg) % 5) < 0.001;

            const line = L.polyline(
                [[leftPt.y, leftPt.x], [rightPt.y, rightPt.x]],
                isMajor ? GRID_STYLE_MAJOR : GRID_STYLE
            );
            this.layerGroup.addLayer(line);
        }
    }

    /** Show/hide the grid */
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
