#!/usr/bin/env node
/**
 * scrape-metadata.js
 * 
 * Scrapes ps1filenames.py for every tile in a full sidereal day at a given
 * latitude band. Outputs a single JSON file suitable for use as a static
 * metadata cache.
 *
 * Usage: 
 *   node scrape-metadata.js                    # default: Medford, MA
 *   node scrape-metadata.js --lat 51.1789      # Stonehenge
 *   node scrape-metadata.js --lat 42.4 --dry   # just show plan, don't fetch
 *
 * Output: metadata_dec<DDMM>.json in current directory
 *
 * Rate limiting: 100ms delay between requests to be polite to STScI.
 * Full scrape of 2160 tiles takes ~4 minutes.
 */

const fs = require('fs');

// --- Config ---
const TILE_SIZE_ARCMIN = 10;
const SEARCH_URL = 'https://ps1images.stsci.edu/cgi-bin/ps1filenames.py';
const DELAY_MS = 100;  // delay between requests
const FILTERS_NEEDED = ['g', 'r', 'i'];

// --- Parse args ---
const args = process.argv.slice(2);
let userLat = 42.4;  // Medford, MA
let dryRun = false;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lat' && args[i + 1]) userLat = parseFloat(args[i + 1]);
    if (args[i] === '--dry') dryRun = true;
}

// --- Compute tile grid ---
const tileSizeDeg = TILE_SIZE_ARCMIN / 60;
const bandDec = Math.round(userLat / tileSizeDeg) * tileSizeDeg;
const totalTiles = Math.round(360 / tileSizeDeg);

// The Dec index for this band (used by image-layer.js tile key system)
const decIndex = Math.round(bandDec / tileSizeDeg);

console.log(`User latitude:  ${userLat}°`);
console.log(`Band Dec:       ${bandDec.toFixed(4)}° (Dec index: ${decIndex})`);
console.log(`Tile size:      ${TILE_SIZE_ARCMIN}' = ${tileSizeDeg.toFixed(4)}°`);
console.log(`Total tiles:    ${totalTiles}`);
console.log(`Estimated time: ${(totalTiles * DELAY_MS / 1000 / 60).toFixed(1)} minutes`);
console.log();

if (dryRun) {
    console.log('Dry run — showing first 5 tile centers:');
    for (let i = 0; i < 5; i++) {
        const ra = i * tileSizeDeg;
        console.log(`  Tile ${i}: RA=${ra.toFixed(4)}° Dec=${bandDec.toFixed(4)}°`);
    }
    console.log(`  ...`);
    console.log(`  Tile ${totalTiles - 1}: RA=${((totalTiles - 1) * tileSizeDeg).toFixed(4)}° Dec=${bandDec.toFixed(4)}°`);
    process.exit(0);
}

// --- Fetch helpers ---

async function fetchMetadata(raDeg, decDeg) {
    const params = new URLSearchParams({ ra: raDeg, dec: decDeg });
    const resp = await fetch(`${SEARCH_URL}?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for RA=${raDeg}`);
    const text = await resp.text();

    const lines = text.trim().split('\n');
    const header = lines[0].split(/\s+/);
    const filterIdx = header.indexOf('filter');
    const filenameIdx = header.indexOf('filename');

    if (filterIdx === -1 || filenameIdx === -1) {
        throw new Error(`Unexpected header format for RA=${raDeg}`);
    }

    const filters = {};
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(/\s+/);
        if (cols.length >= header.length) {
            filters[cols[filterIdx]] = cols[filenameIdx];
        }
    }

    // Verify required filters exist
    for (const f of FILTERS_NEEDED) {
        if (!filters[f]) {
            throw new Error(`Missing ${f} filter at RA=${raDeg}`);
        }
    }

    // Return only the basename (that's what fitscut.cgi uses)
    const result = {};
    for (const f of FILTERS_NEEDED) {
        result[f] = filters[f].split('/').pop();
    }
    return result;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Main scrape ---

async function main() {
    const tiles = [];
    let errors = 0;

    const startTime = Date.now();

    for (let i = 0; i < totalTiles; i++) {
        const ra = i * tileSizeDeg;

        try {
            const filters = await fetchMetadata(ra, bandDec);
            tiles.push({
                raIndex: i,
                ra: parseFloat(ra.toFixed(6)),
                g: filters.g,
                r: filters.r,
                i: filters.i
            });
        } catch (err) {
            console.error(`  ERROR tile ${i} (RA=${ra.toFixed(4)}°): ${err.message}`);
            tiles.push({
                raIndex: i,
                ra: parseFloat(ra.toFixed(6)),
                error: err.message
            });
            errors++;
        }

        // Progress
        if ((i + 1) % 100 === 0 || i === totalTiles - 1) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            const pct = ((i + 1) / totalTiles * 100).toFixed(1);
            console.log(`  ${i + 1}/${totalTiles} (${pct}%) — ${elapsed}s elapsed`);
        }

        if (i < totalTiles - 1) await sleep(DELAY_MS);
    }

    // --- Build output ---

    const output = {
        generated: new Date().toISOString(),
        bandDec: parseFloat(bandDec.toFixed(6)),
        decIndex,
        tileSizeArcmin: TILE_SIZE_ARCMIN,
        tileSizeDeg: parseFloat(tileSizeDeg.toFixed(6)),
        tileCount: totalTiles,
        errors,
        tiles
    };

    // Filename encodes the Dec band
    const decStr = bandDec.toFixed(2).replace('.', '').replace('-', 'neg');
    const outFile = `metadata_dec${decStr}.json`;

    fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

    const fileSizeKB = (fs.statSync(outFile).size / 1024).toFixed(0);
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

    console.log();
    console.log(`Done in ${elapsed} minutes`);
    console.log(`Output: ${outFile} (${fileSizeKB} KB)`);
    console.log(`Tiles: ${tiles.length - errors} OK, ${errors} errors`);
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
