# ZenithTrack - Design Document (Current)

## 1. Purpose
ZenithTrack is a live, real-time sky viewer fixed to the observer's zenith.

The core constraint remains:
- No time travel controls for the end user (no rewind, pause, or fast-forward in public mode)
- The sky is always “now”

The goal is to make Earth’s rotation visible by keeping the viewport fixed while celestial content drifts through it.

## 2. Product State
Current implementation is browser-first and client-only:
- `Leaflet` (`CRS.Simple`) provides rendering and layering
- Astronomy math runs in-browser
- Pan-STARRS imagery is fetched directly from STScI APIs
- SIMBAD object data is fetched directly from SIMBAD TAP
- Image cleanup/enhancement runs client-side on canvas

A server proxy/cache layer remains a possible future component, but as the client path improves, backend necessity is decreasing.

## 3. Core Runtime Model
The app does not pan the camera through the sky. Instead:
1. Compute current zenith (`RA`, `Dec`) from user location + real UTC
2. Keep the viewport centered in Leaflet space
3. Reposition imagery, grid, and labels each animation frame relative to the updated zenith

This creates the “sky is moving past me” effect while preserving a strict real-time experience.

## 4. Data Sources
### 4.1 Pan-STARRS
- Endpoint family: `ps1filenames.py` + `fitscut.cgi`
- Provides RGB JPEG cutouts (`i/r/g` mapping)
- Tile widths are adjusted by `cos(dec)` to keep angular coverage consistent in RA

### 4.2 SIMBAD
- TAP endpoint: `https://simbad.cds.unistra.fr/simbad/sim-tap/sync`
- ADQL queries for object labels and highlights
- Magnitude-limited, brightness-sorted results

## 5. Main Components
- `zenith.js`: Julian date, GMST/LST, zenith RA/Dec, format helpers
- `clock.js`: RAF frame loop + slower tick loop, optional freeze mode
- `image-source.js`: Pan-STARRS fetch and image processing (white-edge cleanup + noise gate)
- `image-layer.js`: tile lifecycle, prefetching, positioning, eviction
- `simbad.js`: periodic cone-style ADQL querying, cache, merge/dedup
- `labels.js`: object markers/labels with edge fade behavior
- `grid.js`: dynamic coordinate grid with adaptive spacing
- `highlights.js`: startup query for notable objects + arrival countdown
- `hud.js`: UTC/RA/Dec/FOV/status readout
- `main.js`: wiring and orchestration

## 6. UI and Interaction
Current UI elements:
- Background sky imagery layer
- Coordinate grid overlay
- SIMBAD labels and highlight emphasis
- HUD (UTC, RA, Dec, FoV, loading)
- Center crosshair
- Location source text
- Fullscreen control
- Info panel for upcoming notable object

Development-only control:
- `Freeze` checkbox (diagnostic; not for production user flow)

Note: user-facing zoom controls are being removed from the public experience; FOV is intended to be set by configuration while tuning continues.

## 7. Configuration (`main.js`)
These options are currently in active use/tuning:

### 7.1 Runtime / Experience Settings
- `fovArcmin`:
  - Horizontal field-of-view in arcminutes
  - Drives visual drift speed, query geometry, and map zoom fit
  - Still evolving
- `tileSizeArcmin`:
  - Angular tile size requested from Pan-STARRS
  - Trades request count vs download size/seam behavior
  - Still evolving
- `gridSpacingArcmin`:
  - Base grid density
  - Grid layer may adapt spacing at wider FoVs
  - Still evolving
- `simbadMagnitudeLimit`:
  - Label population cap by brightness
- `highlightCount`:
  - Number of highlight candidates loaded from SIMBAD
- `hudUpdateMs`:
  - Tick interval for HUD + periodic data updates
- `unitsPerDegree`:
  - Celestial-to-Leaflet coordinate scale constant
- `defaultLat`, `defaultLon`:
  - Fallback location when geolocation is unavailable

### 7.2 Development / Diagnostic Settings
- `diagnostic`:
  - Enables on-screen diagnostic coordinate labeling
- `diagnostic_coordinate_lock`:
  - Locks center to fixed RA/Dec (ignores live location/time)
- `showFreeze`:
  - Shows/hides freeze checkbox
  - Freeze is for development only
- `timeOffsetMinutes`:
  - Synthetic clock offset for testing
- Shift-click tile export (when frozen):
  - Downloads both original and processed tile images for inspection

## 8. Diagnostic Functions (Separated)
Diagnostic functionality exists to validate astrometry, tile alignment, and processing quality:
- Coordinate lock mode for repeatable target checks
- Tile boundary overlays + coordinate text (`diagnostic=true`)
- Freeze-time inspection workflow
- Shift-click tile capture for before/after processing comparison
- Console logging for query cadence, tile counts, and source URLs

These tools are intentionally not part of the public product narrative.

## 9. Performance and Behavior Notes
- Startup overlay remains until first image tile is loaded
- Continuous operation depends on tile prefetch and cache eviction
- Label rendering uses viewport-edge alpha fades to reduce pop-in/out
- SIMBAD querying is rate-limited by motion step + in-flight guard

## 10. Roadmap Direction
Likely near-term:
- Continue tuning `fovArcmin`, `tileSizeArcmin`, `gridSpacingArcmin`
- Remove/finish cleanup of any legacy zoom paths
- Refine label density and highlight cadence
- Improve mobile/desktop visual consistency

Possible later:
- Optional backend proxy/cache (if needed for reliability, quotas, or performance)
- Additional overlays (careful to preserve “live zenith-only” constraint)

## 11. Product Principles
- Real time is the product
- Presence over control
- Minimal UI, maximal motion legibility
- Diagnostics are for development, not the user experience
