# Artemisos Google Drive FITS proof of concept

This update is additive and does **not** change the existing sky viewer. No existing backend routes, HTML templates, application JavaScript, CSS, main dependencies, or Render Blueprint settings are modified.

## Quick start

1. Copy these new files and folders into the matching paths in your existing GitHub repository.
2. Keep `main.py`, `render.yaml`, and the current viewer files unchanged.
3. Commit the new files. Render will redeploy the site as usual.
4. Open `https://YOUR-RENDER-SERVICE.onrender.com/static/drive-test.html`.
5. Click **Test JavaScript access** to probe the public file submitted by your team. This tests anonymous cross-origin access to the initial FITS header only; it does not download whole FITS files.
6. If that fails, click **Open public Drive file**. Download the file and choose it in **Local FITS fallback**. Then check the header or opt into caching the selected file locally via OPFS.
7. Read `docs/GOOGLE_DRIVE_INTEGRATION.md` for limitations, optional OAuth uploader instructions, and next development steps.

The uploader is a local developer utility and must not be run on Render Free. Never commit OAuth credentials or tokens.
