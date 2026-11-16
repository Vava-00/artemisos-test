# Deployment and configuration

This project provides **one** Flask application. The `render.yaml` file is the canonical Render Blueprint configuration. Python 3.11 is specified by `.python-version` and `render.yaml`.

## Deploy using Render Blueprint

1. Create a GitHub repository and commit the **contents** of the `artemisos-release/` folder to its root.
2. Make sure `.env`, `.cache/`, Python virtual environments, and FITS data are not committed (`.gitignore` already excludes them).
3. In the [Render dashboard](https://dashboard.render.com/), choose **New → Blueprint**, connect the repository, and review the service configuration.
4. Deploy. Render installs `requirements.txt` and runs:

   ```bash
   gunicorn --workers 1 --threads 2 --timeout 180 --bind 0.0.0.0:$PORT main:app
   ```

5. Open `https://<your-host>/health` and verify `{"status":"ok","service":"artemisos-spherex"}`.
6. Open the main page and perform an actual SPHEREx sky search. The health check alone does **not** verify remote archive access.
7. If you intend to demonstrate spectra, WISE, or stacks, test each optional feature on the deployed instance before presenting it.

If deploying manually, create a **Python web service**, use the same install and start commands, and configure the environment variables from `render.yaml`.

## Render Free boundaries

The included free-tier configuration sets `SPHEREX_ALLOW_ADVANCED=false`, keeps a single Gunicorn worker with two threads, reduces preview cache quotas, and places the cache in `/tmp`. This avoids intentionally downloading large full-frame FITS files on a memory-limited service.

Render Free instances may sleep during inactivity and use ephemeral storage. Actual CPU, RAM, disk space, bandwidth, network behavior, and free-plan policies are governed by Render and may change. Large optional jobs (HiPS cubes, WISE alignment, detector stacks) are **not guaranteed** to finish on a low-memory server.

**Do not enable full-FITS Advanced mode on an under-provisioned instance.** It may download multi-gigabyte files and consume substantial CPU, memory, and disk resources.

## Environment variables

The project includes `.env.example` for reference. **Neither `python main.py` nor Gunicorn automatically reads `.env`**. Export variables in the shell or configure them in your deployment environment; never commit local secrets.

| Name | Default or source | Purpose |
| --- | --- | --- |
| `PORT` | `5000` locally; provider-supplied in production | Listen port |
| `FLASK_DEBUG` | `false` | Development-only debug mode |
| `SPHEREX_ALLOW_ADVANCED` | `true` locally; `false` in Render Blueprint | Allow or reject full FITS previews |
| `SPHEREX_CACHE_DIR` | `.cache/spherex` locally | Runtime cache root |
| `SPHEREX_PREVIEW_CACHE_MB` | `512` locally; `128` in Render Blueprint | Preview-cache quota (MB) |
| `SPHEREX_PREVIEW_CACHE_FILES` | `2500` locally; `1000` in Render Blueprint | Maximum preview cache files |
| `SPHEREX_MAX_FULL_FITS_MB` | `2048` | Individual full-FITS size limit (MB) |
| `SPHEREX_FULL_CACHE_MB` | `8192` | Full-FITS cache quota (MB) |
| `SPHEREX_MAX_FULL_PIXELS` | `150000000` | Full-frame pixel safety limit |
| `SPHEREX_CUBE_ROOT` | DR1 HiPS archive root set in `cube_spectrum.py` | Alternative IRSA cube root |
| `SPHEREX_CUBE_S3_ROOT` | Public fallback defined in `cube_spectrum.py` | Alternative mirror |
| `SPHEREX_CUBE_ALLOW_FULL_DOWNLOAD` | `0` | Explicit opt-in fallback to large full-cube downloads |
| `MPLCONFIGDIR` | Set to `/tmp/artemisos-matplotlib` by Render Blueprint | Matplotlib writable cache |

For production deployments on the free plan, leave `SPHEREX_CUBE_ALLOW_FULL_DOWNLOAD=0` and `SPHEREX_ALLOW_ADVANCED=false`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `/health` fails | Service logs, build status, Gunicorn command, installed dependencies, listen port |
| Page loads but Search fails | IRSA connectivity, source collections in `main.py`, upstream timeouts, backend logs |
| Only some observations appear | Look for the `partial` catalog warning; DR1 or QR3 may be temporarily unavailable |
| Advanced mode unavailable | Expected when `SPHEREX_ALLOW_ADVANCED=false` |
| Cube returns 503 | Remote HiPS availability, range requests, `hpgeom`/`fsspec`/Astropy dependencies, quotas |
| WISE images are missing or slow | Use browser Network timings to distinguish `/api/wise/search` (IRSA catalog lookup), `/api/wise/preview` (FITS cutout and PNG preparation), and `/api/wise/overlay` (optional WCS reprojection). Check Render logs, cold starts, memory and the availability of the upstream archive. Concurrent 50+ frame detector stacks can compete for network, CPU, and memory on small instances. First-time requests can be slower than cached ones. |
| Detector stack fails | WCS/coverage mismatch, flags, remote access, concurrent job, server restarts |
| High memory/disk use | Disable Advanced mode, lower cache budgets, avoid large optional jobs on Free |

Production health and availability require **manual** verification on the deployed server; passing offline tests is not proof of remote-data readiness.

## References

- [Render Flask deployment](https://render.com/docs/deploy-flask)
- [Render free service limits](https://render.com/docs/free)
- [IRSA SPHEREx mission archive](https://irsa.ipac.caltech.edu/Missions/spherex.html)
