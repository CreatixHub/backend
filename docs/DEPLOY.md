# Deploying the backend

Pushing to `main` deploys automatically (`.github/workflows/deploy.yml`). The workflow type-checks and builds, uploads
`dist/`, `prisma/`, `package.json` and `package-lock.json` to the droplet, installs production dependencies, restarts the
`karkaii-api` service and waits for `GET /api/health`. If the API does not become healthy it restores the previous
release and fails the run.

Database migrations and the permission seed run **inside the service start** (`ExecStartPre` in the systemd unit), as the
`karkaii` service user, using the `DATABASE_URL` in `/etc/karkaii/api.env`. A failing migration therefore fails the
health check and triggers the rollback. The CI user never sees the database password.

## What lives where (droplet `64.227.129.36`)

| Thing | Location |
|---|---|
| Code | `/opt/karkaii/api` (owned by `deploy`, readable by group `karkaii`) |
| Previous release (for rollback) | `/opt/karkaii/api.deploy/prev` |
| Secrets (database URL, JWT secret) | `/etc/karkaii/api.env` (`root:karkaii`, mode 640) - never in git |
| Service | `karkaii-api` (`/etc/systemd/system/karkaii-api.service`), runs as user `karkaii`, port 5000 on localhost |
| nginx | `/etc/nginx/sites-available/karkaii`: `location ^~ /api/` proxies to `127.0.0.1:5000` |

## First deployment checklist

1. **DigitalOcean database:** a database `karkaii` and user `karkaii_app` exist and the user has the grants from the guide
   (chapter C0.3). The droplet is in the cluster's **Trusted sources** (it already can connect).
2. **Database URL on the server** (do not paste it anywhere else):
   ```
   ssh root@64.227.129.36
   nano /etc/karkaii/api.env       # set DATABASE_URL="postgresql://karkaii_app:PASSWORD@HOST:25060/karkaii?sslmode=require&connection_limit=5"
   ```
   If Prisma reports a certificate error, append `&sslaccept=accept_invalid_certs` (or use the cluster CA certificate).
3. **Cookies:** the site is served over plain HTTP, so `COOKIE_SECURE=false` is set. Browsers drop `Secure` cookies on
   http. As soon as the site has a domain and HTTPS, change it to `COOKIE_SECURE=true` and restart the service.
4. `git push` to `main` (or run the workflow manually: Actions, Deploy backend, Run workflow).
5. Check: `curl http://64.227.129.36/api/health` returns `{"success":true,"data":{"status":"ok"}}`.

## Everyday commands

```
ssh root@64.227.129.36 "journalctl -u karkaii-api -n 80 --no-pager"      # logs
ssh root@64.227.129.36 "systemctl status karkaii-api --no-pager"          # status
ssh root@64.227.129.36 "systemctl restart karkaii-api"                     # restart (also re-runs migrations + seed)
```

Manual rollback to the previous release:
```
ssh root@64.227.129.36 "rsync -a --delete /opt/karkaii/api.deploy/prev/ /opt/karkaii/api/ && systemctl restart karkaii-api"
```
(Migrations are not undone by a rollback: write migrations that are backwards compatible.)

Cut off CI access at any time:
```
ssh root@64.227.129.36 "sed -i '/ gha:backend\$/d' ~deploy/.ssh/authorized_keys"
```

## Notes

- The droplet runs Node 24; CI builds with Node 22 and the code is plain JavaScript output, so this is fine. Prefer
  keeping both on the same major version in the long run.
- The old demo deployment scripts in the monorepo's `deploy/` folder are for the previous Express server and are not used.
- Never add the database URL to the workflow file or to `package.json`.
