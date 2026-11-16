# Optional .gitignore additions

The complete project ZIP already includes these extra entries in `.gitignore`.
If you are copying only the add-on files into an existing repository, manually add:

```gitignore
# Google OAuth files — store them outside the repository as well
client_secret*.json
client_secrets*.json
credentials*.json
google_token*.json
*oauth*token*.json
.oauth/
```

Keep OAuth client secrets and refresh tokens outside the Git repository even when ignored.
