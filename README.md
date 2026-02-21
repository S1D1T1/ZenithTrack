# ZenithTrack

ZenithTrack is a live, client-side sky viewer fixed to the point directly overhead (the zenith). Our purpose is to make Earth's rotation *feel* visible: the viewport is fixed - the motion is not by panning or time lapse, but provided by the Earth's actual live rotation. This requires a zoom level extreme enough to make the earth's live motion visible. The more you zoom in, the bigger things get, and *the faster they move*. To reveal motion - we use our (virtual) telescope as an "Angular Velocity Amplifier" showing a tiny sliver of the sky drift visibly - and genuinely - in real time.

Live page:

- https://smorgasb.org/zenith

Further technical discussion:

- https://smorgasb.org/zenith-tech

## Current Release

This browser-based implementation includes:

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
