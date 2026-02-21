/**
 * hud.js - Heads-Up Display
 *
 * Updates the on-screen readout with current UTC time and zenith coordinates.
 * Registered as a 'tick' listener on the Clock (default: once per second).
 */

import { formatRA, formatDec } from './zenith.js';

export class HUD {
    constructor() {
        this.utcEl = document.getElementById('hud-utc');
        this.raEl = document.getElementById('hud-ra');
        this.decEl = document.getElementById('hud-dec');
        this.objectsEl = document.getElementById('hud-objects');
        this.fovEl = document.getElementById('hud-fov');
    }

    /**
     * Update the HUD display.
     * @param {Date} now - current time
     * @param {number} raDeg - zenith RA in degrees
     * @param {number} decDeg - zenith Dec in degrees
     * @param {number} objectCount - number of SIMBAD objects in cache
     * @param {number} fovArcmin - configured FOV in arcminutes (maps to window width)
     */
    update(now, raDeg, decDeg, objectCount = null, fovArcmin = null) {
        this.utcEl.textContent = now.toISOString().substring(11, 19);
        this.raEl.textContent = formatRA(raDeg);
        this.decEl.textContent = formatDec(decDeg);
        if (this.objectsEl && objectCount !== null) {
            this.objectsEl.textContent = `${objectCount} SIMBAD object${objectCount !== 1 ? 's' : ''}`;
        }
        if (this.fovEl && fovArcmin !== null) {
            // fovArcmin is always mapped to window width.
            // Vertical FOV is proportional to aspect ratio.
            const vFov = fovArcmin * window.innerHeight / window.innerWidth;
            this.fovEl.textContent = `${fovArcmin.toFixed(1)}' × ${vFov.toFixed(1)}'`;
        }
    }
}
