# ZenithTrack

ZenithTrack is a live, client-side sky viewer fixed to the point directly overhead (the zenith). It is built to make Earth's rotation *feel* visible: the viewport is fixed while the sky drifts continuously in real time.

Live page:

- https://smorgasb.org/zenith

Further technical discussion:

- https://smorgasb.org/zenith-tech

## Current Release

This first release is a browser-based implementation with:

- Real-time zenith RA/Dec tracking from user location + UTC
- Pan-STARRS imagery tiles (client-fetched and client-processed)
- SIMBAD object labels and curated "highlight" objects
- A minimal HUD and information panel
- Diagnostic tools for development/testing

## Project Layout

- `app/` - application source (HTML/CSS/JS)
- `ZenithTrack design.md` - design/architecture notes

## Running Locally

Use a local HTTP server from the repository root:

```bash
python3 -m http.server 8080
```

Open:

- `http://localhost:8080/app/`

Notes:

- Geolocation behavior depends on browser policy. Depending on browser settings, some users may not even see a request to share their location before the browser rejects it.
- If geolocation is unavailable, ZenithTrack falls back to a default location (Stonehenge).

## Controls

Public-facing controls:

- `fullscreen`

Developer diagnostics:

- `freeze` (development-only)
- `Zoom` button (jumps simulated time to 30 seconds before the next highlight)

## Runtime Diagnostics API

From browser devtools console:

```js
window.zenithTrack.setTimeOffsetMinutes(240)
window.zenithTrack.getTimeOffsetMinutes()
```

This lets you jump simulated time without restarting the app.

## Data Sources

- Pan-STARRS image cutouts via STScI endpoints
- SIMBAD TAP/ADQL queries for objects/highlights

## Known Scope / Limitations

- Highlight selection is tuned for current FoV strip and may be adjusted over time
- Diagnostic features are intentionally present for iteration and QC

## License

MIT. See `LICENSE`.
