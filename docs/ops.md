# Ops Runbook

On-call reference for the Memories Scanner backend.

## Quick reference

| Symptom | First check |
|---|---|
| iPhone scan stuck at "Analyzing…" | Backend reachable? `curl https://api.example.com/health` |
| `/auth/apple` returns 401 | `APPLE_CLIENT_ID` matches bundle id? |
| 400 "Invalid host" on /any route | Caller's `Host:` header not in `TRUSTED_HOSTS` |
| Disk fills up | Run `python scripts/cleanup_uploads.py --days 30` |
| All sessions logged out | `SESSION_SECRET` rotated; expected after rotation |

## Deploy (Fly.io)

```bash
# one-time
fly launch --no-deploy --name memories-scanner-api --copy-config

# create a 1 GB persistent volume for SQLite + uploads/processed
fly volumes create backend_data --size 1 --region <your-region>

# inject secrets (NEVER commit these)
fly secrets set \
    APPLE_CLIENT_ID=com.memoriesscanner.app \
    SESSION_SECRET="$(openssl rand -hex 32)" \
    ENV=production \
    ALLOWED_ORIGINS="https://memoriesscanner.app" \
    TRUSTED_HOSTS="api.memoriesscanner.app"

# deploy
fly deploy
```

HTTPS is terminated by Fly's proxy — no certificate work on our side.

## Rotate `SESSION_SECRET`

The session JWT is signed with `SESSION_SECRET`. Rotating it
invalidates every issued token, so every user has to re-authenticate
via Sign in with Apple on next launch (one tap; no password
involved).

```bash
fly secrets set SESSION_SECRET="$(openssl rand -hex 32)"
# fly deploy is implicit; the machine restarts
```

Rotate when:
- you suspect leak (commits, screenshots, an ex-employee's laptop),
- annually as hygiene,
- after an integration that may have captured it (audit logs / 3rd-party services).

## Backup SQLite (Litestream)

Litestream streams SQLite WAL frames to S3-compatible object storage
in near-real-time. Not yet wired up — to enable:

1. Provision an S3 bucket (or Cloudflare R2 / Backblaze B2).
2. Add Litestream to the Dockerfile:
   ```dockerfile
   COPY --from=litestream/litestream:0.3.13 /usr/local/bin/litestream /usr/local/bin/litestream
   ```
3. Add `backend/litestream.yml`:
   ```yaml
   dbs:
     - path: /data/memories.db
       replicas:
         - type: s3
           bucket: memories-scanner-backups
           path: prod/memories.db
           region: us-east-1
   ```
4. Wrap the gunicorn `CMD` with `litestream replicate -exec '<cmd>'`.

Restore: `litestream restore -o /data/memories.db s3://memories-scanner-backups/prod/memories.db`.

## Disk full

If `/data/uploads` fills the Fly volume:

```bash
fly ssh console -C "python /app/scripts/cleanup_uploads.py --days 30"
```

This deletes uploaded JPEGs whose `Photo` row is gone **and** that are
older than N days. Schedule it as a cron once you've validated the
output a few times. The script never touches the DB or the
`processed/` dir.

## Recover from a bad deploy

```bash
fly releases               # list recent deploys
fly releases rollback <n>  # roll back to release <n>
```

State (SQLite, uploads) lives on the volume and survives.

## What is NOT yet wired

- **Error reporting / structured logs.** No Sentry, no JSON logging,
  no request-id correlation. The original observability PR was closed;
  reopen it before treating any of the above as production-ready.
- **Litestream backups.** Documented above, not yet wired.
- **Paging integration** (Slack / PagerDuty alerts).
- **Multi-region.** One Fly machine. To scale: set
  `RUN_MIGRATIONS_ON_START=false`, run migrations as a one-shot
  release_command, then bump `min_machines_running` in `fly.toml`.
  Switch to Postgres before adding a second region.
