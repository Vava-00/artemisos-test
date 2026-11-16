# Google Drive FITS integration — isolated proof of concept

This add-on does **not** change the working Artemisos Sky Viewer. Its purpose is to validate Google Drive download behavior, check FITS signatures, exercise local browser storage, and prepare an authorized upload utility. The existing `main.py`, viewer scripts, template, dependencies, tests, and `render.yaml` are unchanged.

## Known project details

- Google Cloud project: `artemisos-spherex-storage`
- Existing institutional folder ID: `1Azn504ZusxxGnQjFsG1nmIYmn_XC-4R6`
- Public test file ID: `1yY7JmmuEkVBOWkJ6MsiYnBFuycskQk8C`
- Test file page: https://drive.google.com/file/d/1yY7JmmuEkVBOWkJ6MsiYnBFuycskQk8C/view

**These IDs were supplied by the team, not independently verified.** Google Cloud project creation and anyone-with-the-link sharing are reported as permitted by the institution. That does not prove anonymous JavaScript access, file content, or that this particular folder is accessible under the `drive.file` OAuth scope.

## Phase A: browser access diagnostic (no OAuth, no server changes)

1. Add `static/drive-test.html`, `static/js/drive-helpers.js`, and `static/js/drive-test.js` to the current repository. Leave the existing site files in place.
2. Commit the files and let Render deploy the new static resources.
3. Open **`https://YOUR-SERVICE.onrender.com/static/drive-test.html`**. The main site is still at `/`.
4. Click **Test JavaScript access**. The page tries *anonymous* byte-range requests against a Drive browser-download URL and the Drive REST endpoint. It reads and cancels after one response chunk. Look for `FITS primary HDU`, `gzip stream`, `HTML/JSON`, HTTP 403, or `network/CORS/redirect restriction`.
5. Click **Open public Drive file** to check that a normal browser download works independently of CORS.
6. If direct JavaScript access fails, download the FITS in the browser, select it using the local file picker, and click **Check local FITS header**.
7. Optionally click **Save selected FITS to browser storage (OPFS)**. This makes a streaming local copy under the isolated folder `artemisos-drive-test` on the user's device. The user must explicitly choose the file. The page provides a button to delete only this test cache.
8. Copy the diagnostic result (no credentials) to your project team.

### How to interpret results

| Result | Meaning | Next action |
|---|---|---|
| Public link downloads; browser probe reads FITS header | Direct public fetch may be feasible for this endpoint | Test a complete authorized transfer, quota and browser FITS reader on a small observation |
| Public link works; both JavaScript probes fail | HTML download does not imply cross-origin JavaScript access | Offer explicit download + local import; consider a storage service designed for CORS-enabled web distribution |
| Probe reads HTML/JSON rather than FITS | Drive gave a viewer, warning or API error | Do not treat it as an image; inspect Drive permissions and download behavior |
| Drive link itself fails in incognito | The file is not anonymously downloadable | Correct share permissions or institution policy before proceeding |
| Local file picker finds valid FITS header | The user can access FITS bytes locally | Build an in-browser FITS reader in a separate development branch |

The test deliberately **does not render scientific FITS images**. The JavaScript probe is not proof that a full multi-hundred-MB FITS can be transferred, nor that Google Drive is suitable as a production CDN. Drive may disregard Range and may impose rate/traffic limits.

## Phase B: optional upload to Drive from a developer's computer

Do **not** store Google OAuth credentials or run this script on Render. Do not enable billing for this experiment unless explicitly needed and approved.

1. Download a Google OAuth **Desktop app** client JSON from the team's Cloud project and keep it outside GitHub, e.g. `~/private/artemisos-client-secret.json`.
2. On your own computer, install only the optional uploader dependencies:

   ```bash
   python -m pip install -r tools/requirements-drive.txt
   ```

3. From the already working `/api/search?ra=133.79513&dec=-7.24515&radius=0.02`, copy the exact `obs_id`, `access_url`, and detector (`bands` key) for an observation. Download that original FITS from the official IRSA access URL (or its existing viewer link). Do not invent observation IDs or use a cutout URL as the identity for a full exposure.
4. Validate without authorizing Google:

   ```bash
   python tools/drive_uploader.py \
     --file /path/to/observation.fits \
     --obs-id "EXACT_IRSA_OBS_ID" \
     --band 3 \
     --access-url "https://irsa.ipac.caltech.edu/ibe/data/spherex/.../original.fits" \
     --folder-id "1Azn504ZusxxGnQjFsG1nmIYmn_XC-4R6" \
     --dry-run
   ```

5. Once inputs validate, remove `--dry-run`, add `--client-secrets /path/to/client.json`, and run the uploader locally. A browser window will ask the institutional user to approve `drive.file` access. The refresh token stays at `~/.config/artemisos/drive_oauth_token.json` and **must never be committed**.
6. With the default command, the uploaded file remains **private** and the public manifest is unchanged. If the content is approved for public access, use `--publish` to explicitly make that *one uploaded file* readable by anyone and add its mapping to `static/data/drive_manifest.json`. This action cannot be undone from the script; you may revoke the share in Drive.
7. The existing institution-created folder might be unavailable under the narrow `drive.file` scope. If Drive returns 403/404, use `--create-app-folder` **instead of** `--folder-id`. This creates a new app-owned folder in My Drive rather than accessing the original folder. Do **not** broaden OAuth permissions to `drive` simply to work around this without institutional review.
8. The public manifest should be committed **only if** the files were deliberately shared publicly. The manifest is informational; the main viewer does not consume it yet.

### Security and deployment notes

- Never commit client secrets, access tokens, refresh tokens, or private Drive file metadata.
- `.gitignore` includes patterns to reduce accidental OAuth file uploads. Keep credentials outside the repository regardless.
- The Drive viewer link is for humans; it is **not** a stable CORS-enabled binary endpoint.
- If there is no direct CORS-supported read, use downloaded local files (OPFS) or investigate a dedicated object-storage bucket such as Cloudflare R2 for public FITS distribution.
- The browser caches only selected files with the user's permission. Storage quotas and eviction depend on browser and device.
- The live viewer remains on Quick with Advanced disabled on Render Free. This add-on is a proof of concept, **not a new production Full FITS mode**.

## Checks

Run without contacting Google or IRSA:

```bash
python -m unittest discover -s tests -p 'test_*.py' -v
node tests/test_drive_helpers.cjs
node tests/test_viewer.cjs
node tests/test_share_url.cjs
node tests/test_spectrum.cjs
```

## Official background

- Drive API binary downloads: https://developers.google.com/workspace/drive/api/guides/manage-downloads
- Drive API least-privilege scopes: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Drive API public links may require resource keys: https://developers.google.com/workspace/drive/api/guides/resource-keys
- Origin-private file system: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system
