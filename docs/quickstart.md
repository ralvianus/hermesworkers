# Quickstart

This guide walks through deploying `hermesworkers` to a fresh Cloudflare account in roughly 10 minutes.

## Prerequisites

- A Cloudflare account on the [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) (Sandbox containers require it).
- [`wrangler`](https://developers.cloudflare.com/workers/wrangler/install-and-update/) 4.0.0 or newer.
- Docker Desktop (or compatible) running locally.
- An API key for **at least one** of: Anthropic, OpenRouter, OpenAI.

## 1. Clone and install

```bash
git clone https://github.com/ralvianus/hermesworkers.git
cd hermesworkers
npm install
```

## 2. Create your local deployment config

Deployments read from `wrangler.local.toml` (git-ignored); the committed `wrangler.toml` is just the template. Start from the template and pick a unique worker name:

```bash
cp wrangler.toml wrangler.local.toml
$EDITOR wrangler.local.toml   # set `name`; optionally the dashboard routes/vars
```

## 3. Log into Cloudflare

```bash
npx wrangler login
npx wrangler whoami   # copy your Account ID
```

## 4. Set your account ID (shell, not the repo)

No config file in this repo stores an `account_id`. Export it once in your shell profile instead:

```bash
export CLOUDFLARE_ACCOUNT_ID="abcdef0123456789..."   # add to ~/.zshrc / ~/.bashrc
```

## 5. (Local dev) Create `.dev.vars`

If you plan to run `npm run dev` locally, copy the secrets template and fill in values:

```bash
cp .dev.vars.example .dev.vars
```

## 6. Push your provider API key(s)

You need **at least one** of these. Add more later if you want to mix providers.

```bash
# Pick one (or several)
npm run secret -- put ANTHROPIC_API_KEY
npm run secret -- put OPENROUTER_API_KEY
npm run secret -- put OPENAI_API_KEY
```

Wrangler prompts you for each value; nothing is written to disk locally.

## 7. Push a Worker bearer token (required)

The Worker fails closed: without an `API_TOKEN`, every `/v1/*` and `/api/*` request returns `503`. Generate a random token and add it:

```bash
openssl rand -hex 32 | npm run secret -- put API_TOKEN
```

If your shell can't pipe into the script, just run it interactively:

```bash
openssl rand -hex 32            # copy the output
npm run secret -- put API_TOKEN   # paste when prompted
```

## 8. Deploy

```bash
# Docker Desktop must be running — Cloudflare builds the container image locally.
npm run deploy
```

The first deploy takes a few minutes while the Hermes image builds (~3 GB of Python deps). Subsequent deploys reuse layers and finish in seconds.

When the deploy completes, wrangler prints something like:

```
Deployed hermesworkers-yourname triggers (X.XX sec)
  https://hermesworkers-yourname.<your-subdomain>.workers.dev
```

## 9. Smoke test

```bash
WORKER_URL=https://hermesworkers-yourname.<your-subdomain>.workers.dev
TOKEN=<your API_TOKEN value>

# Health check
curl -s "$WORKER_URL/api/health" -H "Authorization: Bearer $TOKEN"

# First chat — expect 15–60 s cold start
curl -N "$WORKER_URL/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello, Hermes. Say one short sentence."}],
    "stream": true
  }'
```

You should get back an SSE stream of `data: {...}` chunks, with the final `data: [DONE]` marking the end of the response.

## 10. (Optional) Wake the container ahead of time

If you know a chat is coming and want to skip the cold-start wait, fire a wake call first:

```bash
curl -X POST "$WORKER_URL/api/instance/wake" \
  -H "Authorization: Bearer $TOKEN"
```

This boots the Hermes processes without sending a chat message, so the next request hits a warm gateway.

## Next steps

- Wire a custom hostname to expose Hermes' native dashboard — [custom-domain.md](custom-domain.md).
- Switch providers or run multiple models — [byok-setup.md](byok-setup.md).
- Understand how requests flow through the Worker — [architecture.md](architecture.md).
