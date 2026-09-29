# Architecture

A walk-through of how a chat request flows through `hermesworkers`, and how the moving parts fit together.

## Components

```
┌────────────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker  (src/index.ts)                                     │
│  ─────────────────────────────────────────────────────────────────     │
│  Hono router:                                                          │
│    • GET  /api/health                                                  │
│    • POST /v1/chat/completions      ──► routes/chat.ts                 │
│    • POST /api/instance/wake        ──► routes/instance.ts             │
│    • POST /api/instance/restart                                        │
│    • POST /api/instance/restart-gateway                                │
│    • POST /api/instance/stop                                           │
│    • GET  /api/instance/logs                                           │
│                                                                        │
│  Pre-router hook:                                                      │
│    • maybeHandleDashboard  ──► services/dashboard-proxy.ts             │
└──────┬─────────────────────────────────────────────┬──────────────────┘
       │ ensureGateway()                             │ containerFetch
       │ startProcess()                              │ (HTTP or WebSocket)
       ▼                                             ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Durable Object: HermesInstance                                        │
│  ─────────────────────────────────────────────────────────────────     │
│  Sandbox container (built from container/Dockerfile)                   │
│    ├─ port 18789 — Hermes API server (OpenAI-compatible)               │
│    └─ port 9119  — Hermes native dashboard (web UI + WebSocket)        │
│                                                                        │
│  Startup script: /usr/local/bin/start-hermes.sh                        │
│    1. Configure Hermes API server (token, port, bind 0.0.0.0)          │
│    2. Materialise ~/.hermes/.env from BYOK env vars                    │
│    3. Pin default model                                                │
│    4. Launch dashboard (port 9119) in background                       │
│    5. exec hermes gateway (port 18789, foreground)                     │
└────────────────────────────────────────────────────────────────────────┘
```

## A chat request, step by step

1. **Client → Worker.** The caller `POST`s an OpenAI-shaped body to `/v1/chat/completions` with `Authorization: Bearer <API_TOKEN>`.
2. **Auth check.** The Worker's `requireToken` middleware (in `src/index.ts`) returns `401` if the token doesn't match, and `503` while `API_TOKEN` is unset — traffic is served without a token only when the deployment sets `ALLOW_UNAUTHENTICATED=true` (local dev only).
3. **Resolve the container.** `getContainer(env)` returns the deterministic Durable Object stub (`env.HERMES.idFromName('main')`).
4. **Ensure the gateway is alive.** `ensureGateway()` does, in order:
   - Look for a tracked process whose command matches `hermes gateway` or `start-hermes.sh`.
   - If found and the port responds within 5 minutes → return.
   - If found but the port isn't responding → kill and reboot.
   - If not found but port 18789 already responds → return (race-safety net).
   - Otherwise call `startProcess('/usr/local/bin/start-hermes.sh', { env: BYOK_SECRETS })` and wait for port 18789.
5. **Proxy to Hermes.** The Worker constructs a `Request` to `http://localhost:18789/v1/chat/completions` and calls `container.containerFetch(req, 18789)`. The Sandbox SDK handles the network tunnel.
6. **Stream the response back.** Hermes returns a Server-Sent Events stream. The Worker re-uses the stream's `body` and pipes it back to the client unmodified.

The Worker holds no state across requests. All conversation history, cron jobs, skills configuration etc. live inside `~/.hermes/` in the container.

## Dashboard subdomain proxy

When `DASHBOARD_HOSTNAME` is set, the Worker's top-level `fetch` calls `maybeHandleDashboard()` **before** the Hono router runs. If the request hostname matches:

1. Same auth gate as the API (`hw_token` cookie, Access JWT, or `Authorization` header); fails closed while `API_TOKEN` is unset.
2. `ensureGateway()` so the dashboard is reachable.
3. Build a `Request` against `http://localhost:9119<path>` and call `containerFetch(req, 9119)`.
4. WebSocket upgrades flow through automatically — the Sandbox SDK preserves the `webSocket` field on the response.

Because the dashboard is served from its own hostname, all absolute URLs in its HTML (`/static/...`, `/v1/...`, `ws://.../ws`) resolve correctly without any rewriting.

## Cold start vs warm path

- **Cold start.** First request after deploy (or after a 4-hour idle suspend). The container image is pulled, `start-hermes.sh` runs, Hermes registers providers and binds port 18789. End-to-end: ~15–60 s depending on image cache state.
- **Warm path.** Subsequent requests find a running gateway. The Worker → container hop is ~30 ms, then Hermes adds whatever the upstream provider takes.

You can pre-warm with `POST /api/instance/wake` if you know a chat is imminent.

## State and persistence

Cloudflare Sandbox snapshots a configured set of paths when the container is suspended, then restores them on the next boot. By default this includes `/home`, `/workspace`, `/tmp`, `/var/tmp`. The container sets `HOME=/home/hermes`, so all of Hermes' on-disk state — sessions, crons, cached skills, the materialised `~/.hermes/.env` — survives sleep cycles.

Instance **replacement** (image rollout, failure, app deletion) is different: disk is ephemeral, so the snapshot is gone. R2 durability (opt-in, see [`docs/plans/r2-durability-plan.md`](plans/r2-durability-plan.md) and the README "Durable state" section) covers that case in two layers:

- **Memory mount** — the `hermes-data` bucket's `memories/` prefix is s3fs-mounted at `~/.hermes/memories` on every gateway ensure. `MEMORY.md` / `USER.md` writes are durable instantly. Because s3fs does not keep usable R2 connections across a container checkpoint/restore, the Worker health-probes the mount on every request and remounts a wedged one; a failed mount fails closed (503).
- **State snapshots** — after successful chats (debounced, default 15 min) and via `POST /api/instance/backup`, the SDK's `createBackup` archives `~/.hermes` (squashfs) into the bucket's `backups/` prefix. `.env` and `memories` are excluded — secrets never enter R2, and memory is already durable via the mount. Two generations are kept in DO storage; the retired one's objects are deleted.
- **Restore** — a cold boot with no `state.db` (a replaced instance) restores `~/.hermes` before `startProcess`: the Worker mounts `backups/` read-only, copies the archive out, and `unsquashfs` extracts real files (not the SDK's sleep-vanishing overlay restore) so the Sandbox snapshot takes over from the next sleep. All generations failing fails closed rather than booting an empty home over the last good backup.

`POST /api/instance/restart` kills PID 1 and Cloudflare respawns the container — in current platform behaviour **the snapshot is preserved**, so state survives (verified live; the R2 restore path is not exercised by it). A truly fresh disk happens only on an **instance replacement**: a deploy that changes the container image (Dockerfile change triggers a rollout) or a platform-side instance failure. With R2 durability enabled, that case is covered automatically — the memories mount restores memory instantly, and the next request extracts `~/.hermes` from the latest backup before Hermes starts.

## Security model

There is exactly one trust boundary in `hermesworkers`: the Worker.

- The container is unreachable from the public internet except through the Worker's `containerFetch` calls.
- Hermes runs with `GATEWAY_ALLOW_ALL_USERS=true` and binds to `0.0.0.0:18789` — both safe because the only network path in is the Worker.
- BYOK secrets live as Cloudflare encrypted secrets, written to `~/.hermes/.env` at boot and never logged.
- `API_TOKEN` is the single gate at the Worker, and it fails closed: with the token unset, the API and the dashboard return `503` until you explicitly opt in with `ALLOW_UNAUTHENTICATED=true` (local dev only).

If you need finer-grained auth (per-user, OAuth, etc.), put Cloudflare Access in front of the Worker route. `hermesworkers` is intentionally single-tenant; multi-user use cases are out of scope for the open-source repo.
