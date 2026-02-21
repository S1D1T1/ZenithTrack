/**
 * simbad.js - SIMBAD Query Module
 *
 * Queries the SIMBAD TAP service (ADQL) for astronomical objects near a given
 * RA/Dec position. Returns objects with names, types, coordinates, and magnitudes.
 *
 * Uses TAP/ADQL instead of simple cone search to enable:
 *   - Magnitude filtering (show only objects brighter than a threshold)
 *   - Sorting by brightness (brightest first)
 *   - Object type information
 *
 * Manages a cache of queried sky regions to avoid redundant API calls.
 * Prefetches ahead of the current zenith in the RA direction.
 *
 * API: SIMBAD TAP (supports CORS, no auth required)
 * https://simbad.cds.unistra.fr/simbad/sim-tap/sync
 */

const SIMBAD_TAP = 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync';

// How far behind the zenith to keep cached results before discarding
const CACHE_BEHIND_DEG = 0.5;

export class SimbadClient {
    /**
     * @param {number} fovArcmin - field of view in arcminutes (used to scale search)
     * @param {number} maxMagnitude - faintest magnitude to include (lower = fewer, brighter objects)
     * @param {number} maxObjects - maximum objects per query
     */
    constructor(fovArcmin = 15, maxMagnitude = 18, maxObjects = 50) {
        // Scale search parameters to FOV
        const fovDeg = fovArcmin / 60;

        // Search radius: must cover the full viewport diagonal
        this.searchRadiusDeg = fovDeg * 0.75;

        // Prefetch ahead: search one FOV width ahead
        this.prefetchAheadDeg = fovDeg;

        // Query step: re-query when we've moved ~1/3 of the search diameter
        this.queryStepDeg = this.searchRadiusDeg * 0.5;

        // Magnitude and object limits
        this.maxMagnitude = maxMagnitude;
        this.maxObjects = maxObjects;

        console.log(`SIMBAD: FOV=${fovArcmin}' → search radius=${(this.searchRadiusDeg * 60).toFixed(1)}', prefetch=${(this.prefetchAheadDeg * 60).toFixed(1)}' ahead, step=${(this.queryStepDeg * 60).toFixed(1)}', mag limit=${maxMagnitude}`);

        // Cache: array of { raDeg, decDeg, objects, timestamp, maxMag }
        // Each entry represents a queried cone region
        this.cache = [];

        // Track the last RA we queried at, to avoid redundant queries
        this.lastQueryRA = null;

        // Currently in-flight query (to avoid stacking requests)
        this.pendingQuery = null;

        // All objects currently available (merged from cache)
        this.objects = [];

        // Stats
        this.totalQueriesMade = 0;
        this.lastQueryTime = null;

        // Incremented on resets to invalidate stale async query completions.
        this.generation = 0;
    }

    /**
     * Update field of view. Recalculates search parameters and clears cache.
     * @param {number} fovArcmin - new field of view in arcminutes
     */
    setFOV(fovArcmin) {
        const fovDeg = fovArcmin / 60;
        this.searchRadiusDeg = fovDeg * 0.75;
        this.prefetchAheadDeg = fovDeg;
        this.queryStepDeg = this.searchRadiusDeg * 0.5;
        // Invalidate cache — search radii have changed
        this.reset();
        console.log(`SIMBAD: FOV changed to ${fovArcmin}' → search radius=${(this.searchRadiusDeg * 60).toFixed(1)}', prefetch=${(this.prefetchAheadDeg * 60).toFixed(1)}'`);
    }

    /**
     * Change the magnitude limit. Clears cache and forces re-query.
     * @param {number} mag - new maximum magnitude (e.g. 12 = bright only, 20 = include faint)
     */
    setMaxMagnitude(mag) {
        if (mag === this.maxMagnitude) return;
        this.maxMagnitude = mag;
        // Invalidate everything so next update() re-queries with new limit
        this.reset();
        console.log(`SIMBAD: magnitude limit changed to ${mag}`);
    }

    /**
     * Reset cache/query state. Use when simulated time jumps.
     */
    reset() {
        this.generation++;
        this.cache = [];
        this.objects = [];
        this.lastQueryRA = null;
        this.pendingQuery = null;
    }

    /**
     * Update: check if we need to query SIMBAD for new data.
     * Called periodically (not every frame — once per second is fine).
     *
     * @param {number} centerRA - current zenith RA in degrees
     * @param {number} centerDec - current zenith Dec in degrees
     */
    async update(centerRA, centerDec) {
        // Evict old cache entries that are well behind the current view
        this._evictOldEntries(centerRA);

        // Determine if we need a new query
        const queryRA = centerRA + this.prefetchAheadDeg;

        if (this.lastQueryRA !== null) {
            // How far have we moved since last query?
            let moved = queryRA - this.lastQueryRA;
            if (moved < -180) moved += 360; // wraparound
            if (moved < this.queryStepDeg) {
                // Haven't moved enough to justify a new query
                return;
            }
        }

        // Don't stack queries
        if (this.pendingQuery) return;

        const generation = this.generation;
        this.lastQueryRA = queryRA;
        this.pendingQuery = this._query(queryRA, centerDec);

        try {
            const result = await this.pendingQuery;
            if (generation !== this.generation) return;
            if (result && result.length > 0) {
                this.cache.push({
                    raDeg: queryRA,
                    decDeg: centerDec,
                    objects: result,
                    timestamp: Date.now()
                });
            }
            // Rebuild merged object list
            this._rebuildObjectList();
        } catch (err) {
            console.warn('SIMBAD query failed:', err.message);
        } finally {
            if (generation === this.generation) {
                this.pendingQuery = null;
            }
        }
    }

    /**
     * Get all currently known objects. Called every frame for rendering.
     * @returns {Array<{name, type, ra, dec}>}
     */
    getObjects() {
        return this.objects;
    }

    /**
     * Get count of objects currently in cache.
     */
    getObjectCount() {
        return this.objects.length;
    }

    /** @private */
    async _query(raDeg, decDeg) {
        const adql = `SELECT TOP ${this.maxObjects} main_id, ra, dec, otype_txt, V `
            + `FROM basic JOIN allfluxes ON oid = oidref `
            + `WHERE CONTAINS(POINT('ICRS', ra, dec), `
            + `CIRCLE('ICRS', ${raDeg.toFixed(6)}, ${decDeg.toFixed(6)}, ${this.searchRadiusDeg.toFixed(4)})) = 1 `
            + `AND V IS NOT NULL `
            + `AND V < ${this.maxMagnitude} `
            + `ORDER BY V ASC`;

        const body = new URLSearchParams({
            REQUEST: 'doQuery',
            LANG: 'ADQL',
            FORMAT: 'json',
            query: adql
        });

        this.totalQueriesMade++;
        this.lastQueryTime = Date.now();

        const response = await fetch(SIMBAD_TAP, {
            method: 'POST',
            body: body
        });
        if (!response.ok) {
            throw new Error(`SIMBAD TAP HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!data.data || !data.metadata) {
            console.warn('SIMBAD TAP: unexpected response format', Object.keys(data));
            return [];
        }

        const colNames = data.metadata.map(c => c.name);
        console.log(`SIMBAD TAP: ${data.data.length} objects (mag < ${this.maxMagnitude}), columns:`, colNames);

        const nameIdx = colNames.indexOf('main_id');
        const typeIdx = colNames.indexOf('otype_txt');
        const raIdx = colNames.indexOf('ra');
        const decIdx = colNames.indexOf('dec');
        const magIdx = colNames.indexOf('V');

        if (raIdx === -1 || decIdx === -1) {
            console.warn('SIMBAD TAP: missing ra/dec columns in', colNames);
            return [];
        }

        return data.data
            .map(row => ({
                name: row[nameIdx],
                type: row[typeIdx],
                ra: parseFloat(row[raIdx]),
                dec: parseFloat(row[decIdx]),
                mag: magIdx !== -1 ? parseFloat(row[magIdx]) : null
            }))
            .filter(obj => !isNaN(obj.ra) && !isNaN(obj.dec));
    }

    /** @private - Remove cache entries that have scrolled well past the viewport */
    _evictOldEntries(currentRA) {
        this.cache = this.cache.filter(entry => {
            let behind = currentRA - entry.raDeg;
            if (behind < -180) behind += 360;
            if (behind > 180) behind -= 360;
            // Keep if the entry is not too far behind
            return behind < CACHE_BEHIND_DEG + this.searchRadiusDeg;
        });
    }

    /** @private - Merge all cached entries into a single deduplicated object list */
    _rebuildObjectList() {
        const seen = new Set();
        this.objects = [];

        for (const entry of this.cache) {
            for (const obj of entry.objects) {
                // Deduplicate by name + approximate position
                const key = `${obj.name}_${obj.ra.toFixed(4)}_${obj.dec.toFixed(4)}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    this.objects.push(obj);
                }
            }
        }
    }
}
