# ZenithTrack

ZenithTrack is a live, client-side sky viewer fixed to the point directly overhead (the zenith). Our purpose is to make Earth's rotation *feel* visible: the viewport is fixed - the motion is not by panning or time lapse, but provided by the Earth's actual live rotation. This requires a zoom level extreme enough to make the earth's live motion visible. The more you zoom in, the bigger things get, and *the faster they move*. To reveal motion - we use our (virtual) telescope as an "Angular Velocity Amplifier" showing a tiny sliver of the sky drift visibly - and accurately - in real time.

Live page:

- https://smorgasb.org/zenith

Further technical discussion:

- https://smorgasb.org/zenith-tech

## Current Release

This browser-based implementation includes:

- Real-time zenith RA/Dec tracking from user location + UTC
- Pan-STARRS imagery tiles (client-fetched and client-processed)
- Cached metadata eliminates half of all API calls to STScI (see below)
- SIMBAD object labels and curated "highlight" objects
- A minimal HUD and information panel
- Clear mode for distraction-free viewing

## Project Layout

- `app/` - application source (HTML/CSS/JS)
- `app/metadata/` - cached Pan-STARRS tile metadata (one JSON file per declination band)
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

- **F** — toggle fullscreen
- **C** — toggle clear mode (hides all UI, leaving only sky imagery)
- **fullscreen** button (top right)
- **?** button — opens technical notes page

## Cached Metadata

Displaying a Pan-STARRS image tile normally requires two API calls to STScI:

1. **ps1filenames.py** — look up the FITS filenames (g, r, i filters) for a sky position
2. **fitscut.cgi** — request a color JPEG cutout using those filenames

The first call returns small, deterministic data — the same sky position always maps to the same filenames. ZenithTrack pre-caches these filename lookups as static JSON files, one per declination band (10 arcminute intervals), covering -30° to +90° declination (the full Pan-STARRS survey footprint).

This eliminates 50% of API calls to STScI. Each user session now makes only fitscut.cgi image requests — no metadata lookups hit the server at all.

The metadata files are stored in `app/metadata/` and loaded at startup based on the user's latitude.

## Challenges

Oversaturation.

Sensors from this telescope survey oversaturated with even medium brightness stars.

Attempts to process near monochromatic pixels (nearly pure green, pure red) and make them white, also drain the color from tiny red stars. Currently exploring topology-based solutions - "green blobs surrounded by white", etc. such algorithms catch some but not all of the bad pixels, looking like a lazy coloring-book job. We should be able to optimize on the fact that there are no green stars.

## Data Sources

- Pan-STARRS image cutouts via STScI MAST archive
- SIMBAD TAP/ADQL queries for objects/highlights

## Acknowledgements

Thanks to the STScI MAST help desk for prompt and helpful technical support — in particular, guidance on the bulk metadata API that made the caching system possible.

## License

MIT. See `LICENSE`.
