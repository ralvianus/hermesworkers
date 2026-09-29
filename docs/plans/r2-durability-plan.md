# Hermes State Durability via R2 — Approved Plan

Status: approved for implementation (Sep 2026). Captured before exploring
alternatives; the approved architecture is the R2-based one below, not the
zero-secrets or Litestream variants that were also evaluated.

## Goal

Hermes state inside the Sandbox container (`~/.hermes/` — memory files,
`state.db` sessions, skills, crons, config) survives **sleep/wake** via the
Sandbox snapshot of `/home`, but is **lost on container instance replacement**
(image rollout, instance failure, app deletion — disk is ephemeral per
https://developers.cloudflare.com/containers/platform-details/rollouts/).
This plan adds durable R2-backed storage for that state.

## Storage layout (single bucket, one token scope)

```
hermes-data/
├── memories/MEMORY.md, USER.md   ← s3fs-mounted at ~/.hermes/memories (live)
└── backups/{id}/data.sqsh, meta.json  ← periodic ~/.hermes snapshots
```

## Components

### A. Memory mount (live durability)

- s3fs mount of the `hermes-data` bucket, prefix `/memories/`, at
  `/home/hermes/.hermes/memories` — endpoint mount on the installed
  `@cloudflare/sandbox@0.7.21` with R2 API token credentials
  (`RemoteMountBucketOptions`: `endpoint`, `provider: 'r2'`, `credentials`,
  `prefix`)
- Local dev (`wrangler dev`): `localBucket: true` against the local R2
  simulation (binding name as first arg)
- **Fail-closed**: when R2 durability is configured, a mount failure blocks
  chat/dashboard (503) rather than silently writing memory to ephemeral disk
- Health probe on every gateway ensure: write+delete a marker file with a
  timeout — a wedged s3fs (stale TCP after container checkpoint/restore) is
  unmounted and remounted

### B. Periodic backup (~/.hermes snapshots)

- SDK `createBackup({ dir: '/home/hermes/.hermes', excludes: ['.env',
  'memories'], name: 'latest', ttl: 30 days })` → squashfs archive uploaded to
  `hermes-data/backups/{id}/` via presigned URLs
  - 0.7.21 reads `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
    `R2_SECRET_ACCESS_KEY`, `BACKUP_BUCKET_NAME` from the DO env (verified in
    the installed package source)
  - `mksquashfs`/`unsquashfs`/`s3fs` are already in the base image
    `cloudflare/sandbox:0.7.20` (verified) — **no Dockerfile change**, so
    deploying this plan triggers no instance rollout
- `.env` excluded — provider keys/TOKEN never land in R2; the boot script
  re-materializes `.env` from Worker secrets on every boot
- `memories` excluded — they are already durable via the mount
- Pre-backup step: Python sqlite3 WAL checkpoint on `state.db` (consistency;
  `-wal`/`-shm` files are archived alongside anyway)
- Trigger: debounced after successful chat turns (`ctx.waitUntil`, default
  ≥15 min apart via `HERMES_BACKUP_INTERVAL_SEC`) + manual
  `POST /api/instance/backup`. Backup failure is non-fatal (logged)
- Retention: 2 generations (latest + previous) persisted in DO storage;
  the retired generation's R2 objects are deleted after each success
- Auto-cron deliberately rejected: a scheduled backup would wake the
  container, defeating `sleepAfter = 4h` economics

### C. Restore on instance replacement

- In `ensureGateway`'s cold-start path (after memory mount, before
  `startProcess`): if `state.db` is missing AND a backup handle exists in DO
  storage → restore
- Restore mechanics (refined during implementation research): the container
  mounts the bucket's `/backups/` prefix **read-only** via a temporary s3fs
  mount, copies `data.sqsh` to `/tmp`, `unsquashfs -f` extracts into
  `~/.hermes`, then unmounts. No archive bytes transit the Worker (no
  `writeFile` binary-string issues, no 128 MB Worker-memory ceiling)
- **Not** the SDK's `restoreBackup()`: production restore is a FUSE overlay
  that vanishes on every sleep
  (https://developers.cloudflare.com/sandbox/concepts/backup-restore/) and
  would fight the snapshot model. Plain extraction writes real files the
  snapshot then persists normally — the instance converges to standard
  behavior after one restore
- Auto-fallback to the previous generation if the latest fails to extract;
  failure of all generations fails closed (503) so a fresh empty home is
  never silently backed up over a good one

## Configuration

- `[[r2_buckets]]` binding `BACKUP_BUCKET` (name required by the Sandbox SDK) → `hermes-data` (both wrangler files;
  used for prune deletes + local-dev `localBucket` mode)
- `[vars]`: `HERMES_R2_ENDPOINT` (R2 S3 endpoint), `BACKUP_BUCKET_NAME`,
  `CLOUDFLARE_ACCOUNT_ID` (presigned URLs — a Worker var, distinct from the
  CLI's shell env; lives only in git-ignored `wrangler.local.toml`),
  `HERMES_BACKUP_INTERVAL_SEC` (default "900")
- Secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — an R2 API token
  scoped to **`hermes-data` only**, Object Read & Write (dashboard → R2 →
  Manage R2 API Tokens). Scope limit is the mitigation for s3fs writing the
  token to a password file inside the container
- Feature is opt-in: unset `HERMES_R2_ENDPOINT` (or incomplete config) →
  durability disabled with a logged warning, chat unaffected

## Code touchpoints

- `src/lib/container.ts` — `Env` additions + `collectR2Durability(env)`
- `src/services/container-lifecycle.ts` — `ensureMemoryMount`,
  `ensureRestored`, `runBackup`; wired into `ensureGateway`
- `src/hermesContainer.ts` — DO methods `getBackupState`/`setBackupState`
  (handle persistence in DO storage)
- `src/routes/chat.ts` — debounced post-chat backup trigger
- `src/routes/instance.ts` — `POST /api/instance/backup` (force)
- `src/services/dashboard-proxy.ts`, wake/restart-gateway routes — pass R2
  config into `ensureGateway`
- Docs: README, `.dev.vars.example`, `docs/architecture.md`, `AGENTS.md`

## Deployment & verification order

1. Push R2 secrets (after creating the scoped token)
2. `npm run deploy` (Worker code only — image unchanged, no rollout)
3. `POST /api/instance/backup` → first backup captures current live state
4. Pre-seed `memories/MEMORY.md` + `USER.md` into R2 from the current container
   (before the first mounted boot; the mount overlays the local dir)
5. `POST /api/instance/restart-gateway` → mount active; verify a chat-saved
   memory via `wrangler r2 object get hermes-data/memories/MEMORY.md`
6. Durability test: `POST /api/instance/restart` (fresh instance, empty disk)
   → wake → chat → memory + sessions survive (R2 mount + restore extraction)
   → `GET /api/instance/logs` clean

## Alternatives evaluated (not chosen)

- **Zero-new-secrets variant** — DO-storage mirroring of memory files +
  tar/zip state archives transported via the R2 binding: simplest, no R2
  token, but backup transport buffers archives in Worker memory (128 MB
  ceiling) and memory RPO equals the debounce window
- **Litestream** continuous SQLite WAL replication: best RPO, but adds a
  binary to the image (→ rollout), S3 creds in container, most moving parts
- **D1 / DO-SQLite as the state store**: impossible as primary stores —
  Hermes' Python opens a local SQLite file; D1/DO are Worker-runtime APIs
  with no filesystem or wire access from the container. Only viable as
  mirrors, adding a translation layer with no durability gain (see
  conversation, Sep 2026)
- **SDK `restoreBackup()`**: rejected — production restore is a sleep-vanishing
  FUSE overlay
- **Scheduled cron backups**: rejected — wakes the container, defeating
  `sleepAfter`
