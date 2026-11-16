#!/usr/bin/env python3
"""Optional local-only uploader for public SPHEREx FITS files in Google Drive.

Never run this on Render Free. The installed application uses the limited
`drive.file` scope, and stores its OAuth token outside this repository.

The public manifest is updated only after an explicit --publish request
successfully grants anyone-reader permission to an uploaded file.
"""

import argparse
from datetime import datetime, timezone
import gzip
import json
import os
from pathlib import Path
import re
from urllib.parse import urlsplit

SCOPES = ["https://www.googleapis.com/auth/drive.file"]
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "static" / "data" / "drive_manifest.json"
DEFAULT_TOKEN = Path.home() / ".config" / "artemisos" / "drive_oauth_token.json"
MAX_FILE_BYTES = 2 * 1024**3
ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{10,128}$")


def valid_irsa_url(value):
    """Accept only expected public NASA IRSA SPHEREx FITS URL forms."""
    try:
        parsed = urlsplit(value)
        return (parsed.scheme == "https"
                and parsed.hostname == "irsa.ipac.caltech.edu"
                and parsed.port in (None, 443)
                and parsed.username is None and parsed.password is None
                and parsed.path.startswith("/ibe/data/spherex/")
                and parsed.path.lower().endswith((".fits", ".fits.gz")))
    except ValueError:
        return False


def inspect_fits(path):
    """Validate the primary FITS signature without loading a large image."""
    path = Path(path)
    if not path.is_file():
        raise ValueError(f"FITS file not found: {path}")
    if not path.name.lower().endswith((".fits", ".fits.gz")):
        raise ValueError("Expected a .fits or .fits.gz file.")
    size = path.stat().st_size
    is_gzip = path.name.lower().endswith(".fits.gz")
    if size < (20 if is_gzip else 80) or size > MAX_FILE_BYTES:
        raise ValueError("FITS file is empty/invalid or exceeds the 2 GiB safety limit.")
    opener = gzip.open if is_gzip else open
    try:
        with opener(path, "rb") as stream:
            header = stream.read(80)
    except (OSError, EOFError) as exc:
        raise ValueError("Could not read the FITS header.") from exc
    if not header.startswith(b"SIMPLE  ="):
        raise ValueError("The file does not start with a standard primary FITS header.")
    return size


def upsert_manifest(path, entry):
    """Write one publicly accessible FITS mapping atomically."""
    path = Path(path)
    if path.is_file():
        data = json.loads(path.read_text(encoding="utf-8"))
    else:
        data = {"schema_version": 1, "observations": []}
    if data.get("schema_version") != 1 or not isinstance(data.get("observations"), list):
        raise ValueError("The manifest is not an Artemisos Drive manifest (version 1).")
    rows = [row for row in data["observations"]
            if row.get("irsa_access_url") != entry["irsa_access_url"]]
    rows.append(entry)
    data["observations"] = sorted(rows, key=lambda row: (row["band"], row["obs_id"]))
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    try:
        temp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def authorize(client_secrets, token_path):
    """Desktop OAuth authorization; requires an interactive local browser."""
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow

    credentials = None
    if token_path.exists():
        credentials = Credentials.from_authorized_user_file(str(token_path), SCOPES)
    if not credentials or not credentials.valid:
        if credentials and credentials.expired and credentials.refresh_token:
            credentials.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(str(client_secrets), SCOPES)
            credentials = flow.run_local_server(port=0)
        token_path.parent.mkdir(parents=True, exist_ok=True)
        token_path.write_text(credentials.to_json(), encoding="utf-8")
        try:
            token_path.chmod(0o600)
        except OSError:
            pass
    return credentials


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=Path, required=True, help="Local .fits or .fits.gz")
    parser.add_argument("--obs-id", required=True, help="Exact IRSA catalog obs_id")
    parser.add_argument("--band", type=int, required=True, choices=range(1, 7))
    parser.add_argument("--access-url", required=True, help="Exact IRSA catalog access_url")
    parser.add_argument("--folder-id", help="Target folder accessible to drive.file scope")
    parser.add_argument("--create-app-folder", action="store_true",
                        help="Create a new app-owned folder in My Drive")
    parser.add_argument("--client-secrets", type=Path,
                        help="OAuth Desktop client JSON downloaded from Google Cloud")
    parser.add_argument("--token-path", type=Path, default=DEFAULT_TOKEN)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--publish", action="store_true",
                        help="Explicitly set anyone-reader sharing and add to public manifest")
    parser.add_argument("--dry-run", action="store_true", help="Validate inputs; do not contact Drive")
    args = parser.parse_args(argv)

    if args.folder_id and args.create_app_folder:
        parser.error("Use --folder-id OR --create-app-folder, not both.")
    if not args.folder_id and not args.create_app_folder:
        parser.error("Supply --folder-id or --create-app-folder.")
    if args.folder_id and not ID_PATTERN.fullmatch(args.folder_id):
        parser.error("Invalid Drive folder ID.")
    if not args.obs_id.strip() or len(args.obs_id) > 250:
        parser.error("Invalid observation ID.")
    if not valid_irsa_url(args.access_url):
        parser.error("Expected an official HTTPS IRSA SPHEREx .fits/.fits.gz access URL.")
    try:
        size = inspect_fits(args.file)
    except ValueError as exc:
        parser.error(str(exc))
    print(f"FITS header accepted: {args.file.name}, {size:,} bytes, Band {args.band}")
    if args.dry_run:
        print("Dry run complete: no authorization, network request, or manifest change.")
        return 0
    if not args.client_secrets or not args.client_secrets.is_file():
        parser.error("Provide --client-secrets pointing to your local OAuth Desktop JSON.")

    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    from googleapiclient.http import MediaFileUpload

    drive = build("drive", "v3", credentials=authorize(args.client_secrets, args.token_path), cache_discovery=False)
    folder_id = args.folder_id
    if args.create_app_folder:
        created = drive.files().create(
            body={"name": "Artemisos-SPHEREx-Uploads", "mimeType": "application/vnd.google-apps.folder"},
            fields="id,name").execute()
        folder_id = created["id"]
        print(f"Created app-owned folder: {folder_id}")

    metadata = {"name": args.file.name, "parents": [folder_id],
                "description": f"Artemisos SPHEREx observation {args.obs_id}; Band {args.band}"}
    try:
        uploaded = drive.files().create(
            body=metadata,
            media_body=MediaFileUpload(str(args.file), mimetype="application/fits",
                                       chunksize=8 * 1024 * 1024, resumable=True),
            fields="id,name,size,md5Checksum,webViewLink,resourceKey").execute()
    except HttpError as exc:
        if getattr(exc.resp, "status", 0) in (403, 404):
            raise SystemExit(
                "Google Drive denied access to that folder. With drive.file scope, "
                "a pre-existing folder may not be accessible. Try --create-app-folder "
                "or ask your institution to authorize a supported access path."
            ) from exc
        raise

    file_id = uploaded["id"]
    print(f"Uploaded file ID: {file_id}")
    print(f"View: https://drive.google.com/file/d/{file_id}/view")
    if not args.publish:
        print("Private upload complete. No entry was added to the public manifest.")
        return 0
    try:
        drive.permissions().create(
            fileId=file_id, body={"type": "anyone", "role": "reader"}, fields="id"
        ).execute()
    except HttpError as exc:
        raise SystemExit(
            "The institution may prohibit anyone-reader permissions. "
            "The uploaded file remains private and was NOT added to the manifest."
        ) from exc
    entry = {
        "obs_id": args.obs_id.strip(),
        "band": args.band,
        "irsa_access_url": args.access_url,
        "drive_file_id": file_id,
        "web_view_link": f"https://drive.google.com/file/d/{file_id}/view",
        "filename": uploaded.get("name", args.file.name),
        "size_bytes": int(uploaded.get("size", size)),
        "md5_checksum": uploaded.get("md5Checksum"),
        "uploaded_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    if uploaded.get("resourceKey"):
        entry["resource_key"] = uploaded["resourceKey"]
    upsert_manifest(args.manifest, entry)
    print(f"Public manifest updated: {args.manifest}")
    print("Upload complete. An anonymous download and CORS test are still required.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
