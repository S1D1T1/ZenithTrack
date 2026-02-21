/**
 * highlights.js - Notable Object Highlights
 *
 * Queries SIMBAD once at startup for the brightest Messier/NGC/IC objects
 * in the declination band matching the user's latitude. As the sky drifts,
 * shows an info panel when each highlight object approaches the viewport.
 *
 * The user's zenith traces a constant-declination strip (Dec = latitude)
 * across the full 360 degrees of RA over a sidereal day. This module finds
 * the most interesting objects in that strip and announces them.
 */

import { formatRA, formatDec } from './zenith.js';

const SIMBAD_TAP = 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync';
// Query at least this declination half-band (degrees), then post-filter
// to the exact FoV half-height to avoid missing candidates in sparse strips.
const MIN_QUERY_HALF_DEG = 0.15;
// Ask for a much larger candidate pool, then curate locally.
const QUERY_OVERSAMPLE_FACTOR = 12;
const QUERY_MAX_ROWS = 300;
// Minimum angular separation between selected highlights.
const MIN_SEPARATION_ARCMIN = 8;

// State modes
const IDLE = 0;

/**
 * Normalize an RA difference to the range (-180, +180).
 */
function deltaRA(ra1, ra2) {
    let d = ra1 - ra2;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
}

function angularSeparationArcmin(a, b) {
    // Small-angle approximation is sufficient at these tiny separations.
    const dDec = a.dec - b.dec;
    const meanDecRad = ((a.dec + b.dec) / 2) * Math.PI / 180;
    let dRA = a.ra - b.ra;
    if (dRA > 180) dRA -= 360;
    if (dRA < -180) dRA += 360;
    const dRAProj = dRA * Math.cos(meanDecRad);
    return Math.hypot(dRAProj, dDec) * 60;
}

function isStarLikeType(type) {
    if (!type) return false;
    // SIMBAD star-like classes usually contain '*' markers (e.g. *, **, Pe*, V*).
    return type.includes('*');
}

function baseCatalogKey(name) {
    if (!name) return null;
    const normalized = name.trim().replace(/\s+/g, ' ');
    const m = normalized.match(/^(M|NGC|IC|UGC|PGC|C|Cr|Melotte|Barnard|Sh2)[\s-]+(\d+)/i);
    if (!m) return null;
    return `${m[1].toUpperCase()} ${m[2]}`;
}

function magScore(obj) {
    return Number.isFinite(obj.mag) ? obj.mag : 99;
}

// Sidereal rate: Earth rotates 360° in one sidereal day (23h 56m 4.1s).
// RA of zenith increases at this rate.
const SIDEREAL_DEG_PER_SEC = 360 / (23 * 3600 + 56 * 60 + 4.1);

export class Highlights {
    /**
     * @param {number} fovArcmin - field of view in arcminutes
     * @param {number} [count=8] - number of highlights to query from SIMBAD
     */
    constructor(fovArcmin, count = 8) {
        this.halfFovDeg = (fovArcmin / 60) / 2;
        this.count = count;
        this.highlights = [];
        this.centerDec = null;
        this.state = IDLE;
        // Name of the highlight currently pinned as "Now Visible"
        this.activeVisibleName = null;
    }

    /**
     * Query SIMBAD for notable objects in the declination band.
     * Call once at startup. Results are sorted by RA (order of appearance).
     *
     * @param {number} latDeg - user's latitude in degrees (= zenith declination)
     */
    async load(latDeg) {
        this.centerDec = latDeg;
        const targetHalfDeg = this.halfFovDeg;
        const queryHalfDeg = Math.max(targetHalfDeg, MIN_QUERY_HALF_DEG);
        const queryTop = Math.max(this.count, Math.min(QUERY_MAX_ROWS, this.count * QUERY_OVERSAMPLE_FACTOR));
        const decMin = (latDeg - queryHalfDeg).toFixed(6);
        const decMax = (latDeg + queryHalfDeg).toFixed(6);

        const adql = `SELECT TOP ${queryTop} main_id, ra, dec, otype_txt, V `
            + `FROM basic JOIN allfluxes ON oid = oidref `
            + `WHERE dec BETWEEN ${decMin} AND ${decMax} `
            + `AND V IS NOT NULL `
            + `AND (`
            + `main_id LIKE 'M %' OR main_id LIKE 'NGC %' OR main_id LIKE 'IC %' `
            + `OR main_id LIKE 'UGC %' OR main_id LIKE 'PGC %' `
            + `OR main_id LIKE 'C %' OR main_id LIKE 'Cr %' OR main_id LIKE 'Melotte %' `
            + `OR main_id LIKE 'Barnard %' OR main_id LIKE 'Sh2-%'`
            + `) `
            + `ORDER BY V ASC`;

        const body = new URLSearchParams({
            REQUEST: 'doQuery',
            LANG: 'ADQL',
            FORMAT: 'json',
            query: adql
        });

        const response = await fetch(SIMBAD_TAP, { method: 'POST', body });
        if (!response.ok) {
            throw new Error(`Highlights: SIMBAD TAP HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!data.data || !data.metadata) {
            console.warn('Highlights: unexpected SIMBAD response format');
            return;
        }

        const colNames = data.metadata.map(c => c.name);
        const nameIdx = colNames.indexOf('main_id');
        const typeIdx = colNames.indexOf('otype_txt');
        const raIdx = colNames.indexOf('ra');
        const decIdx = colNames.indexOf('dec');
        const magIdx = colNames.indexOf('V');

        if (raIdx === -1 || decIdx === -1) {
            console.warn('Highlights: missing ra/dec columns');
            return;
        }

        const parsed = data.data
            .map(row => ({
                name: row[nameIdx],
                type: row[typeIdx],
                ra: parseFloat(row[raIdx]),
                dec: parseFloat(row[decIdx]),
                mag: magIdx !== -1 ? parseFloat(row[magIdx]) : null
            }))
            .filter(obj => !isNaN(obj.ra) && !isNaN(obj.dec));

        const inVisibleStrip = parsed.filter(obj => Math.abs(obj.dec - latDeg) <= targetHalfDeg);
        const nonStellar = inVisibleStrip.filter(obj => !isStarLikeType(obj.type));

        // Collapse sub-components (e.g. "NGC 1039 302") to one parent candidate.
        const byCatalogKey = new Map();
        const uniqueCandidates = [];
        for (const obj of nonStellar) {
            const key = baseCatalogKey(obj.name);
            if (!key) {
                uniqueCandidates.push(obj);
                continue;
            }
            const prev = byCatalogKey.get(key);
            if (!prev || magScore(obj) < magScore(prev)) {
                byCatalogKey.set(key, obj);
            }
        }
        uniqueCandidates.push(...byCatalogKey.values());

        // Prefer bright objects, then apply a spatial cull to avoid dense clusters
        // dominating the whole ribbon.
        uniqueCandidates.sort((a, b) => magScore(a) - magScore(b));
        const minSepArcmin = Math.max(MIN_SEPARATION_ARCMIN, targetHalfDeg * 60);
        const selected = [];
        for (const obj of uniqueCandidates) {
            const tooClose = selected.some(keep => angularSeparationArcmin(obj, keep) < minSepArcmin);
            if (!tooClose) selected.push(obj);
            if (selected.length >= this.count) break;
        }

        this.highlights = selected;

        // Sort by RA ascending — order of appearance across the sidereal day.
        this.highlights.sort((a, b) => a.ra - b.ra);
        this.resetState();

        // Log what we found
        console.log(`Highlights: query band ±${(queryHalfDeg * 60).toFixed(1)}' around Dec ${latDeg.toFixed(4)}°`);
        console.log(`Highlights: visible strip ±${(targetHalfDeg * 60).toFixed(1)}' → raw ${parsed.length}, in-strip ${inVisibleStrip.length}, non-stellar ${nonStellar.length}, final ${this.highlights.length}`);
        for (let i = 0; i < this.highlights.length; i++) {
            const h = this.highlights[i];
            const raStr = formatRA(h.ra).replace(/\s+/g, '');
            const magStr = h.mag != null ? `V=${h.mag.toFixed(1)}` : '';
            console.log(`  ${i + 1}. ${h.name}  (${h.type})  ${magStr}  RA ${raStr}`);
        }
    }

    /**
     * Update field of view (adjusts viewport edge calculation for ETA).
     * @param {number} fovArcmin - new field of view in arcminutes
     */
    setFOV(fovArcmin) {
        this.halfFovDeg = (fovArcmin / 60) / 2;
        if (this.centerDec !== null) {
            this.highlights = this.highlights.filter(h => Math.abs(h.dec - this.centerDec) <= this.halfFovDeg);
        }
        this.resetState();
    }

    /** Reset transient countdown/cooldown state. */
    resetState() {
        this.state = IDLE;
        this.activeVisibleName = null;
    }

    /** Whether the highlights system is idle (not showing or in cooldown). */
    isIdle() {
        return this.state === IDLE;
    }

    /** Get the set of highlight object names. */
    getNames() {
        return new Set(this.highlights.map(h => h.name));
    }

    /**
     * Find the next highlight that will enter the viewport and compute its ETA.
     * Returns null if no highlights are loaded.
     *
     * @param {number} currentRA - current zenith RA in degrees
     * @returns {{ obj: object, etaSec: number } | null}
     */
    getNextUpcoming(currentRA) {
        if (this.highlights.length === 0) return null;

        // Left edge of viewport = highest RA currently visible
        const leftEdgeRA = currentRA + this.halfFovDeg;

        // Find the object with the smallest positive RA distance ahead of the
        // left edge (i.e. the next one to enter the viewport).
        let bestObj = null;
        let bestAhead = Infinity;

        for (const obj of this.highlights) {
            // How far ahead of the left edge is this object?
            let ahead = deltaRA(obj.ra, leftEdgeRA);
            // If ahead < 0, the object is already inside or past the viewport.
            // Wrap it to a full sidereal day ahead (it'll come around again).
            if (ahead < 0) ahead += 360;

            if (ahead < bestAhead) {
                bestAhead = ahead;
                bestObj = obj;
            }
        }

        if (!bestObj) return null;

        // ETA: degrees ahead / sidereal rate
        const etaSec = bestAhead / SIDEREAL_DEG_PER_SEC;

        return { obj: bestObj, etaSec };
    }

    /**
     * Whether an object is currently inside the horizontal FoV.
     * (Highlights are already declination-filtered to the vertical FoV strip.)
     */
    _isHorizontallyVisible(obj, currentRA) {
        return Math.abs(deltaRA(obj.ra, currentRA)) <= this.halfFovDeg;
    }

    /**
     * Returns the currently visible highlight, pinning one object until it exits.
     * This prevents panel flicker/switching while multiple highlights are near.
     */
    getVisibleHighlight(currentRA) {
        if (this.highlights.length === 0) return null;

        if (this.activeVisibleName) {
            const active = this.highlights.find(h => h.name === this.activeVisibleName);
            if (active && this._isHorizontallyVisible(active, currentRA)) {
                return active;
            }
            this.activeVisibleName = null;
        }

        const visible = this.highlights.filter(h => this._isHorizontallyVisible(h, currentRA));
        if (visible.length === 0) return null;

        // If more than one is visible, pick the one closest to center and pin it.
        let selected = visible[0];
        for (const h of visible) {
            if (Math.abs(deltaRA(h.ra, currentRA)) < Math.abs(deltaRA(selected.ra, currentRA))) {
                selected = h;
            }
        }
        this.activeVisibleName = selected.name;
        return selected;
    }

    /**
     * Unified panel data source:
     * - If a highlight is on-screen: mode='visible'
     * - Else: mode='next' with ETA to FoV entry
     */
    getDisplay(currentRA) {
        const visibleObj = this.getVisibleHighlight(currentRA);
        if (visibleObj) {
            return { mode: 'visible', obj: visibleObj };
        }

        const next = this.getNextUpcoming(currentRA);
        if (!next) return null;
        return { mode: 'next', obj: next.obj, etaSec: next.etaSec };
    }

    /**
     * Format an ETA in seconds as hh:mm:ss.
     * @param {number} sec
     * @returns {string} e.g. "02:14:07" or "00:07:30"
     */
    static formatETA(sec) {
        sec = Math.max(0, Math.round(sec));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(h)}:${pad(m)}:${pad(s)}`;
    }

    // Legacy API kept temporarily for compatibility with older call sites.
    check(currentRA, showFn, hideFn) {}
}
