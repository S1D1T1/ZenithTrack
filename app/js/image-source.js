/**
 * image-source.js - Image Source Interface and Implementations
 *
 * Defines the contract for providing sky images, and implements:
 *   - StubImageSource: returns a local sample JPEG for any coordinates
 *   - PanSTARRSImageSource: fetches real images from STScI
 *
 * Contract: given (RA, Dec, sizeArcmin), return a Promise<string> of an image URL.
 * The image is assumed to be square and centered on the given RA/Dec.
 */

/**
 * Tile size in arcminutes. Controls the angular extent of each tile.
 * PanSTARRS native resolution is 0.25 arcsec/pixel.
 * The pixel size sent to the API = TILE_SIZE_ARCMIN * 60 / 0.25.
 *
 *   5  arcmin = 1200 px (default, fast)
 *  10  arcmin = 2400 px
 *  15  arcmin = 3600 px
 *  20  arcmin = 4800 px
 *  25  arcmin = 6000 px (maximum, PanSTARRS limit)
 *
 * Larger tiles = fewer API calls, fewer seams, but bigger downloads.
 */
export let TILE_SIZE_ARCMIN = 5.0;

export function setTileSizeArcmin(size) {
    const maxPixels = 6000;
    const maxArcmin = maxPixels * 0.25 / 60; // 25 arcmin
    TILE_SIZE_ARCMIN = Math.min(size, maxArcmin);
}

// --- Image Processing Configuration ---
// Noise gate: like an audio noise gate, suppresses dim pixels (noise)
// while preserving bright pixels (stars, galaxies).

const IMAGE_PROCESSING = {
    // White edge removal (always on)
    whiteThreshold: 212,
    // Minimum depth (as fraction of tile dimension) to count as fill, not a star
    whiteMinDepthFraction: 0.85,  // 8.5% of tile = ~100px at 1200px

    // Noise gate parameters
    noiseGate: {
        // Below this brightness, pixels go fully black (the "closed" gate)
        low: 120,
        // Above this brightness, pixels pass through unchanged (the "open" gate)
        high: 180,
        // Curve exponent for the transition zone (1.0 = linear, 2.0 = aggressive)
        curve: 3.0
    }
};

// --- Stub Image Source ---

export class StubImageSource {
    constructor(stubUrl = 'images/stub_tile.jpg') {
        this.stubUrl = stubUrl;
    }

    async getImageUrl(raDeg, decDeg) {
        return this.stubUrl;
    }
}

// --- PanSTARRS Image Source ---

export class PanSTARRSImageSource {
    constructor() {
        // Noise gate enabled by default
        this.noiseGateEnabled = true;

        // Download metrics
        this._downloadCount = 0;
        this._downloadBytes = 0;
        this._startTime = performance.now();
    }

    /**
     * Return download metrics since app start.
     * @returns {{ count: number, bytes: number, elapsedSec: number, bytesPerSec: number }}
     */
    getDownloadMetrics() {
        const elapsedSec = (performance.now() - this._startTime) / 1000;
        return {
            count: this._downloadCount,
            bytes: this._downloadBytes,
            elapsedSec,
            bytesPerSec: elapsedSec > 0 ? this._downloadBytes / elapsedSec : 0
        };
    }

    /**
     * Fetches a color JPEG cutout from the PanSTARRS API.
     */
    async getImageUrl(raDeg, decDeg) {
        // Step 1: find filter filenames
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

        // Step 2: request color JPEG
        const basename = (path) => path.split('/').pop();

        const cutoutUrl = 'https://ps1images.stsci.edu/cgi-bin/fitscut.cgi';
        // Compute pixel size from tile arcmin at native 0.25 arcsec/pixel.
        // Dec (height): 1200px for 5 arcmin — straightforward.
        // RA (width): PanSTARRS uses TAN projection where 0.25"/px is on
        // the tangent plane. In RA coordinates, the image spans wider than
        // its pixel count implies, by a factor of 1/cos(dec). To make the
        // image cover exactly TILE_SIZE_ARCMIN of RA, we shrink the width
        // by cos(dec).
        const tilePixelsDec = Math.round(TILE_SIZE_ARCMIN * 60 / 0.25);
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

        const rawUrl = `${cutoutUrl}?${cutoutParams}`;
        const cutoutResp = await fetch(rawUrl);
        if (!cutoutResp.ok) throw new Error(`PanSTARRS cutout HTTP ${cutoutResp.status}`);

        const blob = await cutoutResp.blob();
        this._downloadCount++;
        this._downloadBytes += blob.size;

        const t0 = performance.now();
        const result = await this._processImage(blob);
        const elapsed = performance.now() - t0;

        // Log with UUID so processed images in Sources tab can be traced to originals
        const uuid = result.split('/').pop();
        // console.log(`PanSTARRS tile ${uuid} | ${elapsed.toFixed(0)}ms gate=${this.noiseGateEnabled} | original: ${rawUrl}`);

        return result;
    }

    /**
     * Process image: white edge removal + optional noise gate.
     * Both operations run in a single pixel iteration for efficiency.
     */
    async _processImage(blob) {
        const img = new Image();
        const url = URL.createObjectURL(blob);

        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = url;
        });

        // Images are now rectangular (width adjusted by cos(dec)), so just
        // sanity-check that height matches the expected Dec pixel count.
        const expectedHeight = Math.round(TILE_SIZE_ARCMIN * 60 / 0.25);
        if (img.height !== expectedHeight) {
            console.warn(`PanSTARRS image: ${img.width}×${img.height} (expected height ${expectedHeight})`);
        }

        const canvas = document.createElement('canvas');
        const w = img.width;
        const h = img.height;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');

        // No image transform needed. PanSTARRS JPEG has increasing RA
        // to the LEFT, which matches our coordToXY mapping (increasing
        // RA = decreasing X = leftward on screen).
        ctx.drawImage(img, 0, 0);

        URL.revokeObjectURL(url);

        const imageData = ctx.getImageData(0, 0, w, h);
        const data = imageData.data;
        const whiteThresh = IMAGE_PROCESSING.whiteThreshold;

        // --- Pass 1: White edge removal (scan from edges inward) ---
        // Only black out white strips deeper than minDepth pixels,
        // to avoid carving into stars that touch the tile edge.

        const isWhite = (x, y) => {
            const i = (y * w + x) * 4;
            return data[i] > whiteThresh && data[i + 1] > whiteThresh && data[i + 2] > whiteThresh;
        };

        const setBlack = (x, y) => {
            const i = (y * w + x) * 4;
            data[i] = 0;
            data[i + 1] = 0;
            data[i + 2] = 0;
        };

        const minDepthV = Math.max(1, Math.floor(h * IMAGE_PROCESSING.whiteMinDepthFraction));
        const minDepthH = Math.max(1, Math.floor(w * IMAGE_PROCESSING.whiteMinDepthFraction));

        // Top edge: scan down each column, measure depth, only fill if deep enough
        for (let x = 0; x < w; x++) {
            let depth = 0;
            while (depth < h && isWhite(x, depth)) depth++;
            if (depth >= minDepthV) {
                for (let y = 0; y < depth; y++) setBlack(x, y);
            }
        }

        // Bottom edge: scan up each column
        for (let x = 0; x < w; x++) {
            let depth = 0;
            while (depth < h && isWhite(x, h - 1 - depth)) depth++;
            if (depth >= minDepthV) {
                for (let y = 0; y < depth; y++) setBlack(x, h - 1 - y);
            }
        }

        // Left edge: scan right each row
        for (let y = 0; y < h; y++) {
            let depth = 0;
            while (depth < w && isWhite(depth, y)) depth++;
            if (depth >= minDepthH) {
                for (let x = 0; x < depth; x++) setBlack(x, y);
            }
        }

        // Right edge: scan left each row
        for (let y = 0; y < h; y++) {
            let depth = 0;
            while (depth < w && isWhite(w - 1 - depth, y)) depth++;
            if (depth >= minDepthH) {
                for (let x = 0; x < depth; x++) setBlack(w - 1 - x, y);
            }
        }

        // --- Pass 2: Noise gate (if enabled) ---

        if (this.noiseGateEnabled) {
            const { low, high, curve } = IMAGE_PROCESSING.noiseGate;
            const range = high - low;

            for (let i = 0; i < data.length; i += 4) {
                const r = data[i];
                const g = data[i + 1];
                const b = data[i + 2];

                // Brightness: average of RGB
                const brightness = (r + g + b) / 3;

                if (brightness < low) {
                    // Below threshold: gate closed, go black
                    data[i] = 0;
                    data[i + 1] = 0;
                    data[i + 2] = 0;
                } else if (brightness < high) {
                    // Transition zone: soft knee
                    // Scale factor goes from 0 (at low) to 1 (at high)
                    const t = (brightness - low) / range;
                    const scale = Math.pow(t, curve);
                    data[i] = Math.round(r * scale);
                    data[i + 1] = Math.round(g * scale);
                    data[i + 2] = Math.round(b * scale);
                }
                // Above high: pass through unchanged
            }
        }

        ctx.putImageData(imageData, 0, 0);

        return new Promise((resolve) => {
            canvas.toBlob((processedBlob) => {
                resolve(URL.createObjectURL(processedBlob));
            }, 'image/jpeg', 0.92);
        });
    }
}
