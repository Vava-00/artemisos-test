# HTTP API reference

All endpoints are exposed by **one Flask application** (`main.py`). WISE endpoints are registered by the optional Blueprint in `wise_routes.py` under `/api/wise`. No API key is required by Artemisos; public archive access is subject to the remote provider's availability and policies.

## Endpoints

| Method | Route | Description | Response |
| --- | --- | --- | --- |
| GET | `/` | Render interactive sky viewer | HTML |
| GET | `/health` | Lightweight health check; no remote lookup | JSON |
| GET | `/api/resolve` | Resolve astronomical name via Astropy | JSON |
| GET | `/api/search` | Query SPHEREx observations, grouped by detector | JSON |
| GET | `/api/preview` | Render a validated IRSA FITS image as PNG | PNG or error text |
| POST | `/api/spectrum/point` | Measure one exploratory per-exposure brightness sample | JSON |
| GET | `/api/spectrum/cube` | Read a 102-channel DR1 mosaic pixel spectrum | JSON |
| POST | `/api/stack/start` | Start a WCS-aligned detector stack | JSON |
| GET | `/api/stack/status/<job_id>` | Read stack progress/status | JSON |
| GET | `/api/stack/image/<job_id>` | Retrieve a finished stack | PNG |
| GET | `/api/sky-at-pixel` | Convert image-normalized position to RA/DEC | JSON |
| GET | `/api/wise/search` | Find AllWISE Atlas images covering the region | JSON |
| GET | `/api/wise/preview` | Render WISE image cutout | PNG |
| GET | `/api/wise/overlay` | Align a WISE image over a SPHEREx Quick-mode cutout | PNG |

## Shared parameter rules

- RA and DEC are **ICRS decimal degrees**. RA must be between `0` and `360` inclusive and DEC between `-90` and `90` inclusive. Some operations normalize RA 360° to 0°.
- When accepted, `radius` is in **degrees** and generally must be between `0.001` and `0.5` inclusive. The current **browser Quick-search radius is fixed at 0.02°**, even though the backend search route accepts other valid radii.
- URL parameters `url`, `wise`, and `spherex` must identify trusted public FITS files served by the IRSA archive under supported SPHEREx/WISE paths. They cannot point to arbitrary servers.
- `mode` is `quick` or `advanced`. Advanced mode requires `SPHEREX_ALLOW_ADVANCED=true`; the included Render Free configuration disables it.

## GET `/health`

```json
{"status":"ok","service":"artemisos-spherex"}
```

A successful health check confirms the application is responding, **not** that IRSA is reachable.

## GET `/api/resolve`

Required query parameter: `name`, for example:

```text
/api/resolve?name=Barnard%27s%20Star
```

A successful response includes `status`, `name`, `ra`, and `dec`. A blank name returns HTTP `400`; an unresolvable name returns HTTP `404`.

## GET `/api/search`

Example:

```text
/api/search?ra=133.79513&dec=-7.24515&radius=0.02
```

Successful responses contain:

```json
{
  "status": "ok",
  "total_found": 1,
  "bands": {
    "Band 1": [
      {
        "obs_id": "illustrative-id",
        "s_ra": "133.8",
        "s_dec": "-7.2",
        "date": "2025-08-01T00:00:00 UTC",
        "mjd": 60888,
        "access_url": "https://irsa.ipac.caltech.edu/ibe/data/spherex/example.fits"
      }
    ]
  },
  "collections": ["spherex_dr1", "spherex_qr3"],
  "fallback": false,
  "partial": false,
  "notice": ""
}
```

**The values above are illustrative, not an actual archive response.** `total_found`, band membership, times, and image URLs depend on the request and IRSA. The `bands` object may contain any subset of `Band 1` through `Band 6`. `fallback=true` means the combined catalog query failed and the service queried collections separately; `partial=true` means at least one collection remained unavailable. Empty results are possible. Bad query parameters return `400`; complete upstream failure returns `503`.

## GET `/api/preview`

Parameters: `url` (trusted SPHEREx FITS URL), `mode` (default `quick`), and, for Quick mode, `ra`, `dec`, `radius`.

```text
/api/preview?url=<url-encoded-IRSA-FITS-URL>&ra=133.79513&dec=-7.24515&radius=0.02&mode=quick
```

A successful response is an image (`image/png`). The response may contain `X-SPHEREx-Mode` with the rendered mode. Invalid URLs and coordinates return `400`, Advanced mode disabled returns `403`, and transient FITS-rendering errors return `502`.

## POST `/api/spectrum/point`

Request body (`Content-Type: application/json`):

```json
{
  "access_url": "https://irsa.ipac.caltech.edu/ibe/data/spherex/example.fits",
  "ra": 133.79513,
  "dec": -7.24515,
  "radius": 0.02
}
```

On success, the response includes `status: "ok"` plus the fields `lam`, `width`, `flux`, `err`, `bkg`, `flags`, `flagged_pixels`, `unit`, and `method`. This is an exploratory local measurement, **not a calibrated object spectrum**. A validation error returns `400`; a remote/measurement failure generally returns `502`.

## GET `/api/spectrum/cube`

```text
/api/spectrum/cube?ra=133.79513&dec=-7.24515
```

Reads a 102-channel DR1 HiPS pixel spectrum for the requested position. Successful JSON includes `total_channels` and an array `points` with channel samples (and scientific metadata such as quality/coverage when available). Consult the module and [Scientific notes](SCIENCE.md) for exact semantics; a remote cube may be unavailable, in which case the route returns `503` with an error code. Invalid coordinates return `400`.

## Detector stacking

Start a job:

```http
POST /api/stack/start
Content-Type: application/json
```

```json
{
  "ra": 133.79513,
  "dec": -7.24515,
  "band": 2,
  "access_urls": [
    "https://irsa.ipac.caltech.edu/ibe/data/spherex/example-a.fits",
    "https://irsa.ipac.caltech.edu/ibe/data/spherex/example-b.fits"
  ]
}
```

The response has `status: "ok"` and `job_id`. Poll `/api/stack/status/<job_id>` for `running`, `ready`, or `failed`; retrieve `/api/stack/image/<job_id>` after the image is ready. The job runner is **in-process, best effort, single active job**; it can be lost during a server restart. Incorrect requests return `400`; an overlapping different job may return `409`.

## GET `/api/sky-at-pixel`

Provide `url`, `ra`, `dec`, `radius`, `mode`, and `u`/`v`, the normalized image coordinates each in `[0,1]`. The result returns `ra` and `dec` in degrees. If Advanced mode is disabled, `mode=advanced` returns `403`. For Advanced mode, the full FITS must **already** be cached; clicking does not trigger a full download.

## WISE endpoints

`/api/wise/search` accepts `ra`, `dec`, and optional `radius`, returning an object `bands` keyed by strings `"1"` through `"4"` for available Atlas tiles. Each selected tile contains a trusted `access_url` and identifying metadata. A remote catalog failure returns `503`; the SPHEREx viewer remains usable.

`/api/wise/preview` accepts `url` (a WISE FITS URL) plus `ra`, `dec`, and `radius`, returning a PNG cutout.

`/api/wise/overlay` accepts `wise` and `spherex` FITS URLs plus `ra`, `dec`, and `radius`, returning a registered overlay PNG. This works with **Quick-mode cutouts** and may fail if FITS WCS or coverage is unusable.

## Error contract

- Most JSON endpoints use `{"status":"error","message":"..."}` on failure; some optional routes add `retryable` or `code`.
- Image endpoints may return plain text on errors rather than JSON; use HTTP status codes to determine success.
- Avoid relying on exact human-readable message text for program logic.
- No schema-version field is currently exposed; coordinate any backend API change with the corresponding JavaScript module and regression tests.
