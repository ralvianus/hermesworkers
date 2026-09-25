# hermesworkers

Run [Hermes](https://github.com/NousResearch/hermes-agent) — the [Nous Research](https://nousresearch.com/) personal AI assistant — inside a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) container, fronted by a Cloudflare Worker.

> **Experimental — Not officially endorsed by Nous Research or Cloudflare.** This is a community project. Hermes upstream may break this template at any time; pin the `HERMES_VERSION` value in `container/Dockerfile` if you need stability.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ralvianus/hermesworkers)

---

## What is hermesworkers?

A minimal, single-tenant Cloudflare Worker that:

- builds a Docker image with the [Hermes Agent](https://github.com/NousResearch/hermes-agent) installed,
- runs that image inside a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) container managed by a Durable Object,
- exposes Hermes' OpenAI-compatible API at `/v1/chat/completions`, and
- (optionally) reverse-proxies Hermes' native web dashboard on its own subdomain.

Provider API keys (Anthropic / OpenRouter / OpenAI) are **brought by you** (BYOK) — they live as Cloudflare secrets and are injected at process start. The Worker never persists them and never observes the messages flowing through `/v1/chat/completions`.

You get a personal Hermes that:

- **sleeps when idle** (Sandbox suspends the container after 4 hours of inactivity),
- **wakes on demand** when the next chat request arrives,
- **survives sleep** with Hermes session/cron state preserved under `~/.hermes/` inside the container,
- **runs anywhere Cloudflare runs** (no VPS, no Docker daemon on your machine),
- **optionally runs as a Telegram bot** (`TELEGRAM_BOT_TOKEN` brings the bot online at gateway boot, gated by `TELEGRAM_ALLOWED_USERS`).

## Requirements

- A Cloudflare account with [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) (containers require Workers Paid).
- [`wrangler`](https://developers.cloudflare.com/workers/wrangler/install-and-update/) 4.139.0 or newer.
- Docker Desktop (or compatible) running locally — Cloudflare builds the container image from `container/Dockerfile` during `wrangler deploy`.
- At least one provider API key:
  - [Anthropic](https://console.anthropic.com/) (Claude models), **or**
  - [OpenRouter](https://openrouter.ai/) (multi-provider routing), **or**
  - [OpenAI](https://platform.openai.com/) (GPT models).

## Container cost estimate

These numbers come from [Cloudflare's Sandbox pricing](https://developers.cloudflare.com/sandbox/pricing/) and assume an idle-most-of-the-time personal usage pattern. **Your actual bill will vary.**

| Resource              | Provisioned        | Monthly active usage     | Free tier               | Overage estimate            |
| --------------------- | ------------------ | ------------------------ | ----------------------- | --------------------------- |
| Sandbox container     | 1 × `standard-1`   | ~30 min / day active     | None                    | ~$1.50 / month              |
| Durable Object        | 1                  | < 1 M requests           | 1 M / month             | $0                          |
| Worker requests       | 1 Worker           | < 100 k / month          | 10 M / month            | $0                          |
| LLM inference (BYOK)  | Whatever you pick  | You decide               | N/A                     | Paid to provider directly   |

The Sandbox container scales to zero after `sleepAfter` (default 4 hours). A sleeping container costs nothing. Wake-up takes ~10–30 seconds the first time, then a few seconds for subsequent wakes.

## Architecture

```
            ┌──────────────────────────────────────────────────────┐
  request   │ Cloudflare Worker  ( src/index.ts )                  │
 ─────────► │   ├─ /api/health, /v1/chat/completions, /api/...     │
            │   └─ optional dashboard hostname proxy               │
            └─────────┬────────────────────────────┬───────────────┘
                      │ Sandbox SDK                │
                      │ containerFetch             │ startProcess
                      ▼                            ▼
            ┌──────────────────────────────────────────────────────┐
            │ Durable Object: HermesInstance                       │
            │   └─ Cloudflare Sandbox container                    │
            │        ├─ port 18789 → Hermes API server             │
            │        └─ port 9119  → Hermes native dashboard (web) │
            └──────────────────────────────────────────────────────┘
```

The Worker is stateless. All Hermes state (sessions, crons, cached skills) lives inside `~/.hermes/` in the container and is preserved across sleeps by Cloudflare Sandbox's snapshot behaviour.

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/ralvianus/hermesworkers.git
cd hermesworkers
npm install

# 2. Create your local deployment config from the committed template.
#    wrangler.local.toml is git-ignored and holds deployment-specific values
#    (worker name, routes, vars); wrangler.toml stays the shared example.
cp wrangler.toml wrangler.local.toml
$EDITOR wrangler.local.toml      # at minimum: pick a unique `name`

# 3. Log into Cloudflare
npx wrangler login

# 4. Export your account ID (kept out of the repo).
#    Run `npx wrangler whoami` to grab it, then add to your shell profile:
export CLOUDFLARE_ACCOUNT_ID="<your-account-id>"

# 5. Push at least one provider API key as a secret
npm run secret -- put ANTHROPIC_API_KEY     # or OPENROUTER_API_KEY / OPENAI_API_KEY

# 6. (Recommended) Push a Worker-side bearer token to gate the API.
#    Generate one with: openssl rand -hex 32
npm run secret -- put API_TOKEN

# 7. Deploy (Docker Desktop must be running)
npm run deploy
```

All `npm run deploy` / `dev` / `tail` / `secret` scripts pass `-c wrangler.local.toml` to wrangler. Plain `npx wrangler …` invocations read the template instead — add the same flag when running wrangler manually.

After the first `deploy`, the Worker prints its `*.workers.dev` URL. Smoke test:

```bash
WORKER_URL=https://<your-worker>.<your-account>.workers.dev
TOKEN=<the API_TOKEN you set, or empty if you skipped it>

curl -s "$WORKER_URL/api/health" \
  -H "Authorization: Bearer $TOKEN" | jq

curl -s "$WORKER_URL/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello, Hermes."}],
    "stream": false
  }'
```

The first request triggers a cold start — expect 15–60 seconds. Subsequent requests respond in normal API time.

## Endpoints

| Method | Path                              | Description                                                  |
| ------ | --------------------------------- | ------------------------------------------------------------ |
| GET    | `/`                               | Self-describing JSON (no auth)                               |
| GET    | `/api/health`                     | Liveness probe + Hermes gateway status                       |
| POST   | `/v1/chat/completions`            | OpenAI-compatible chat (streaming supported)                 |
| POST   | `/api/instance/wake`              | Boot the container without sending a chat message            |
| POST   | `/api/instance/restart`           | Hard restart (kills PID 1, Cloudflare respawns the image)    |
| POST   | `/api/instance/restart-gateway`   | Graceful Hermes process restart (re-reads BYOK secrets)      |
| POST   | `/api/instance/stop`              | Stop the Hermes processes (container stays alive)            |
| GET    | `/api/instance/logs`              | Dump process list, Hermes config, server log tail            |
| GET/POST | `/dashboard-login`              | Token login form for the dashboard hostname (sets the `hw_token` cookie) |

All `/v1/*` and `/api/*` paths are gated by `API_TOKEN` if you set it.

## Native dashboard (optional)

Hermes ships a built-in web dashboard (sessions, analytics, models, crons, skills). To make it reachable, wire a hostname under your control to the Worker:

1. Pick a hostname, e.g. `hermes.example.com`, and set it in `wrangler.local.toml`:
   ```toml
   [vars]
   DASHBOARD_HOSTNAME = "hermes.example.com"
   ```
2. Add a proxied DNS record (CNAME) pointing the hostname at your Worker's route target.
3. Add a Worker Route in `wrangler.local.toml`:
   ```toml
   routes = [
     { pattern = "hermes.example.com", custom_domain = true }
   ]
   ```
4. Redeploy:
   ```bash
   npm run deploy
   ```

Visiting `https://hermes.example.com` now proxies straight to the Hermes native UI inside the container. WebSocket upgrades work transparently. If `API_TOKEN` is set, the dashboard hostname requires a credential — in order of preference:

1. **Zero Trust SSO** — if the hostname is fronted by a Cloudflare Access application, set `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` (see [custom-domain.md](docs/custom-domain.md)); the Worker validates the Access JWT and your SSO login is the credential.
2. **Login page** — browsers without an Access session get redirected to `/dashboard-login`, which sets an HttpOnly `hw_token` cookie (30 days) after verifying the token.
3. **Header** — `Authorization: Bearer <token>` for curl / API clients.

See [`docs/custom-domain.md`](docs/custom-domain.md) for a more detailed walk-through.

## Bring Your Own Keys (BYOK)

Hermes routes requests to providers based on the model id (e.g. `anthropic/claude-sonnet-4-5` → Anthropic). For each provider you want to use, push the matching secret:

```bash
npm run secret -- put ANTHROPIC_API_KEY
npm run secret -- put OPENROUTER_API_KEY
npm run secret -- put OPENAI_API_KEY
```

The Worker writes the secrets to `~/.hermes/.env` inside the container on every boot, so:

- rotating a key only needs a `npm run secret -- put <NAME>` followed by `POST /api/instance/restart-gateway`, and
- secrets never appear in the container's image layers.

See [`docs/byok-setup.md`](docs/byok-setup.md) for provider-specific notes (model ids, gateways, rate limits).

## Container lifecycle

The Cloudflare Sandbox keeps the container alive while it has open work, then suspends it after `sleepAfter` (default 4 hours) of inactivity. On suspend, in-memory state is checkpointed; on the next request, the container resumes within seconds.

This Worker does **not** boot the container at deploy time. The first chat (or `POST /api/instance/wake`) triggers `startProcess('/usr/local/bin/start-hermes.sh', ...)`, which:

1. Configures the Hermes API server (port 18789).
2. Writes `~/.hermes/.env` from the provider secrets (and, when set, the Telegram and AI Gateway vars) supplied by the Worker.
3. Pins the default model from `HERMES_DEFAULT_MODEL` (or `anthropic/claude-sonnet-4-5`; in AI Gateway mode the default is `@cf/zai-org/glm-5.3` and all inference routes through `HERMES_AI_GATEWAY_URL`).
4. Launches the native dashboard on port 9119 in the background.
5. Execs `hermes gateway` in the foreground.

`POST /api/instance/restart` kills PID 1; Cloudflare respawns the container from the latest image (useful after `wrangler deploy`). `POST /api/instance/restart-gateway` only kills the Hermes processes; the container stays alive and re-reads `~/.hermes/.env` on the next boot.

## All secrets reference

| Name                       | Required | Purpose                                                                                   |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`        | ¹        | Anthropic API key — written to `~/.hermes/.env`                                           |
| `OPENROUTER_API_KEY`       | ¹        | OpenRouter API key — written to `~/.hermes/.env`                                          |
| `OPENAI_API_KEY`           | ¹        | OpenAI API key — written to `~/.hermes/.env`                                              |
| `API_TOKEN`                | No       | Bearer token required on `/v1/*` and `/api/*` (recommended in production)                 |
| `HERMES_GATEWAY_TOKEN`     | No       | Bearer token between the Worker and the Hermes API server — if unset, the container generates a random one-time token at boot and Worker requests are rejected until it is set |
| `HERMES_DEFAULT_MODEL`     | No       | Default model id (e.g. `anthropic/claude-sonnet-4-5`; in AI Gateway mode it must match the gateway's upstream) |
| `DASHBOARD_HOSTNAME`       | No       | Hostname proxied to the Hermes native dashboard (see "Native dashboard")                  |
| `ACCESS_TEAM_DOMAIN`       | No       | Zero Trust team domain (e.g. `myteam.cloudflareaccess.com`) — enables Access SSO as the dashboard credential |
| `ACCESS_AUD`               | No       | AUD tag of the Access application in front of `DASHBOARD_HOSTNAME` (Zero Trust → Applications → Additional settings) |
| `TELEGRAM_BOT_TOKEN`       | No       | Enables the Telegram platform — bot comes online at gateway boot                           |
| `TELEGRAM_ALLOWED_USERS`   | No       | Comma-separated Telegram user ids allowed to use the bot (recommended; unset = public bot) |
| `HERMES_AI_GATEWAY_URL`    | No       | AI Gateway mode: base URL all inference routes through (see byok-setup.md)                 |
| `HERMES_INFERENCE_TOKEN`   | No       | Bearer token for the AI Gateway (provider key or Cloudflare API token)                     |
| `HERMES_AI_GATEWAY_ID`     | No       | Gateway id sent as `cf-aig-gateway-id` — required for `@cf/...` models (falls back to `default`) |

¹ At least one of the three provider keys is required.

Push secrets with `npm run secret -- put <NAME>` (shorthand for `wrangler secret put … -c wrangler.local.toml`). Plain config values (like `DASHBOARD_HOSTNAME` and `ACCESS_TEAM_DOMAIN`) also live under `[vars]` — in `wrangler.local.toml` for real deployments, never in the committed template.

### Local development secrets

`npm run dev` reads Worker bindings from a git-ignored `.dev.vars` file. Copy the committed template and fill in your values:

```bash
cp .dev.vars.example .dev.vars
```

The `CLOUDFLARE_ACCOUNT_ID` used by the wrangler CLI is a shell environment variable, not a Worker binding — export it in your shell profile rather than putting it in `.dev.vars`:

```bash
export CLOUDFLARE_ACCOUNT_ID="<your-account-id>"
```

### Configuration files

| File | Committed? | Purpose |
| ---- | ---------- | ------- |
| `wrangler.toml` | Yes | Shared template/example — no deployment-specific values. |
| `wrangler.local.toml` | No (git-ignored) | The config actually deployed (`npm run deploy` uses it). Worker name, routes, `[vars]`. |
| `.dev.vars.example` | Yes | Template for local-dev secrets. |
| `.dev.vars` | No (git-ignored) | Local-dev secret values read by `npm run dev`. |

Neither committed file intentionally contains an `account_id` or real hostname; if you ever see one in a diff, treat it as a leak and rotate anything that shared a secret namespace with it.

## Security considerations

- **Set `API_TOKEN`.** Without it, anyone who finds your `*.workers.dev` URL can talk to your Hermes (and bill your provider key). The Worker logs a warning on every unauthenticated request while it is unset. The token is a single shared secret — rotate it with `npm run secret -- put API_TOKEN` followed by `POST /api/instance/restart` if you suspect compromise. Comparison is constant-time.
- **Token-gated endpoints never echo secrets.** `GET /api/instance/logs` redacts values of keys matching `*_API_KEY` / `*_TOKEN` / `*_SECRET` / `*_KEY` / `*_PASSWORD` in all returned output.
- **The container is single-tenant.** Anyone who can reach `/v1/chat/completions` reaches the same Hermes session/state. If you need multi-user separation, run multiple deployments.
- **Hermes' API server runs with `GATEWAY_ALLOW_ALL_USERS=true`** so the Worker proxy can reach it. The Worker is the only gate — keep `API_TOKEN` set in production.
- **Cloudflare AI Gateway is supported natively** — push `HERMES_AI_GATEWAY_URL` and `HERMES_INFERENCE_TOKEN` and every inference call routes through the gateway, no script changes needed. Pass-through keeps your provider key; the `/ai/v1` REST API bills catalog models through Cloudflare (see [`docs/byok-setup.md`](docs/byok-setup.md)).

## Troubleshooting

**`wrangler deploy` complains the Docker CLI isn't available.**
Start Docker Desktop (or `docker context` / `WRANGLER_DOCKER_BIN`-compatible alternative). Cloudflare builds the Sandbox image locally before pushing it.

**Cold start hangs for several minutes.**
The first build downloads ~3 GB of Hermes dependencies. Subsequent boots reuse the cached image. If the gateway never reaches port 18789, check `GET /api/instance/logs` for the tail of `/tmp/hermes-server.log`.

**`hermes config set model` fails with `requires an interactive terminal`.**
You are running the wrong subcommand. Use `hermes config set model "<provider>/<model>"` (note the literal key `model`), not `hermes model` (which is interactive).

**Chat replies are empty (0 prompt + 0 completion tokens).**
Likely the provider key is missing or wrong. Verify with `GET /api/instance/logs` that `~/.hermes/.env` contains the expected entry, then `POST /api/instance/restart-gateway`.

**The dashboard hostname returns 404 / SSL mismatch.**
Confirm: (1) the hostname is set in `wrangler.local.toml`, (2) the Worker route is configured, (3) a proxied (orange-cloud) DNS record exists for that hostname, (4) it is covered by your Universal SSL or a custom certificate.

**Chat replies are empty in AI Gateway mode.**
The token shape must match the URL mode: a provider key for `gateway.ai.cloudflare.com` pass-through, a Cloudflare API token (Account → Workers AI → Read) for the `/ai/v1` REST API. Verify with `GET /api/instance/logs`, then `POST /api/instance/restart-gateway`.

**The Telegram bot doesn't come online.**
Check `GET /api/instance/logs` that `TELEGRAM_BOT_TOKEN set: yes` appears in the boot output; if the secret was added after boot, call `POST /api/instance/restart-gateway`. Without `TELEGRAM_ALLOWED_USERS`, anyone who finds the bot can use it — set the allow-list.

## Known issues

- **PID file race on rapid boots.** If multiple chat requests hit a cold container in parallel, Hermes may log `PID file race lost to another gateway instance` for the losing process(es). The winner serves traffic correctly. A single `wake` request before opening the floodgates avoids the race.
- **Windows CRLF line endings.** Cloning on Windows can mangle `container/start-hermes.sh`. The Dockerfile strips CRs via `sed -i 's/\r$//'`, but make sure your editor saves shell scripts with LF endings.

## Contributing

Issues and pull requests are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the rules of the road.

## Acknowledgements

- [Nous Research](https://nousresearch.com/) for building [Hermes](https://github.com/NousResearch/hermes-agent).
- The Cloudflare team for the Sandbox SDK and the [moltworker](https://github.com/cloudflare/moltworker) reference implementation that this project takes obvious inspiration from.

## License

Apache License 2.0. See [LICENSE](LICENSE).
