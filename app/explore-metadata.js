#!/usr/bin/env node
/**
 * explore-metadata.js
 * 
 * Fetches a few ps1filenames.py samples to understand the metadata structure
 * and whether filenames follow a predictable pattern across RA.
 *
 * Usage: node explore-metadata.js
 * 
 * Uses Medford, MA latitude (~42.4°) bucketed to nearest 10'.
 */

const TILE_SIZE_ARCMIN = 10;
const USER_LAT = 42.4;

// Bucket to nearest 10'
const tileSizeDeg = TILE_SIZE_ARCMIN / 60;
const bandDec = Math.round(USER_LAT / tileSizeDeg) * tileSizeDeg;

console.log(`User latitude: ${USER_LAT}°`);
console.log(`Band Dec: ${bandDec.toFixed(4)}° (${(bandDec * 60).toFixed(1)}')`);
console.log(`Tile size: ${TILE_SIZE_ARCMIN}' = ${tileSizeDeg.toFixed(4)}°`);
console.log(`Total tiles for full 360°: ${Math.round(360 / tileSizeDeg)}`);
console.log();

const SEARCH_URL = 'https://ps1images.stsci.edu/cgi-bin/ps1filenames.py';

async function fetchMetadata(raDeg, decDeg) {
    const params = new URLSearchParams({ ra: raDeg, dec: decDeg });
    const resp = await fetch(`${SEARCH_URL}?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.text();
}

function parseResponse(text) {
    const lines = text.trim().split('\n');
    const header = lines[0].split(/\s+/);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(/\s+/);
        const row = {};
        header.forEach((col, idx) => row[col] = cols[idx]);
        rows.push(row);
    }
    return { header, rows };
}

async function main() {
    // Sample a few tiles spaced across RA to look for patterns
    const sampleRAs = [0, 10, 20, 30, 90, 180, 270, 350];

    console.log('=== Raw response for first sample ===\n');
    const firstRaw = await fetchMetadata(sampleRAs[0], bandDec);
    console.log(firstRaw);
    console.log();

    console.log('=== Parsed filenames across RA samples ===\n');
    console.log(`${'RA'.padStart(6)}  ${'filter'}  filename`);
    console.log('-'.repeat(80));

    const allFilenames = [];

    for (const ra of sampleRAs) {
        const text = await fetchMetadata(ra, bandDec);
        const { rows } = parseResponse(text);
        
        // Extract just g, r, i filters (what ZenithTrack uses)
        const byFilter = {};
        for (const row of rows) {
            byFilter[row.filter] = row.filename;
        }

        allFilenames.push({ ra, filters: byFilter });

        for (const f of ['g', 'r', 'i']) {
            console.log(`${ra.toString().padStart(6)}° ${f.padEnd(6)}  ${byFilter[f] || 'MISSING'}`);
        }
        console.log();
    }

    // Check: do filenames share a common path structure?
    console.log('=== Pattern analysis ===\n');

    // Extract directory paths
    const dirs = new Set();
    for (const entry of allFilenames) {
        for (const f of ['g', 'r', 'i']) {
            if (entry.filters[f]) {
                const dir = entry.filters[f].split('/').slice(0, -1).join('/');
                dirs.add(dir);
            }
        }
    }
    console.log(`Unique directory paths: ${dirs.size}`);
    for (const d of dirs) console.log(`  ${d}`);
    console.log();

    // Extract filename components to look for patterns
    console.log('Filename components (last segment):');
    for (const entry of allFilenames) {
        const iFile = entry.filters['i'];
        if (iFile) {
            const basename = iFile.split('/').pop();
            console.log(`  RA=${entry.ra}°: ${basename}`);
        }
    }
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
