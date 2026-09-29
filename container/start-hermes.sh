#!/bin/bash
# Hermes container startup script.
#
# Launches:
#   1. The Hermes API server (OpenAI-compatible /v1/chat/completions) on port 18789.
#   2. The Hermes native dashboard (web UI + WebSocket) on port 9119, in background.
#
# Provider API keys (Anthropic, OpenRouter, OpenAI) are injected through environment
# variables by the Worker at process start. Hermes reads them from ~/.hermes/.env,
# so we materialize that file from the environment on every boot.

set -e

LOG_FILE=/tmp/hermes-server.log
DASHBOARD_LOG=/tmp/hermes-dashboard.log

echo "=== hermesworkers container startup ===" >&2
echo "ANTHROPIC_API_KEY set: ${ANTHROPIC_API_KEY:+yes}" >&2
echo "OPENROUTER_API_KEY set: ${OPENROUTER_API_KEY:+yes}" >&2
echo "OPENAI_API_KEY set: ${OPENAI_API_KEY:+yes}" >&2
echo "HERMES_GATEWAY_TOKEN set: ${HERMES_GATEWAY_TOKEN:+yes}" >&2
echo "TELEGRAM_BOT_TOKEN set: ${TELEGRAM_BOT_TOKEN:+yes}" >&2
echo "TELEGRAM_ALLOWED_USERS set: ${TELEGRAM_ALLOWED_USERS:+yes}" >&2
echo "AI Gateway mode: ${HERMES_AI_GATEWAY_URL:+enabled}" >&2
echo "HOME: ${HOME:-/home/hermes}" >&2

# Guard: do not start a duplicate gateway if the script is re-invoked while one is alive.
if pgrep -f "hermes gateway" > /dev/null 2>&1; then
    echo "Hermes gateway already running, exiting." >&2
    exit 0
fi

HOME_DIR="${HOME:-/home/hermes}"
mkdir -p "$HOME_DIR/.hermes"

# Configure the Hermes API server before launching the gateway.
# We bind to 18789 (not Hermes' default 8642) so the Worker has a stable target port.
# If HERMES_GATEWAY_TOKEN is unset (local dev without the Worker), generate a
# random one instead of shipping a predictable default. It is written to the
# container log file (NOT stderr — the Worker surfaces stderr in 503 error
# bodies and must never see the token value); a local dev picks it up from
# /tmp/hermes-server.log. Worker-driven boots always set it.
if [ -z "$HERMES_GATEWAY_TOKEN" ]; then
    HERMES_GATEWAY_TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    echo "WARNING: HERMES_GATEWAY_TOKEN not set — generated a random one-time token (see /tmp/hermes-server.log). Worker requests without the matching secret will be rejected." >&2
    echo "Generated HERMES_GATEWAY_TOKEN: $HERMES_GATEWAY_TOKEN" >> "$LOG_FILE"
fi
hermes config set API_SERVER_ENABLED true
hermes config set API_SERVER_KEY "$HERMES_GATEWAY_TOKEN"
hermes config set API_SERVER_PORT 18789

# Hermes reads provider keys + feature flags from ~/.hermes/.env, NOT system env vars.
# Rebuild the file from scratch on each boot so the latest secrets are picked up.
# `|| true` guards against `set -e` aborting when an optional key is unset.
HERMES_ENV_FILE="$HOME_DIR/.hermes/.env"
: > "$HERMES_ENV_FILE"
echo "GATEWAY_ALLOW_ALL_USERS=true" >> "$HERMES_ENV_FILE"
if [ -n "$HERMES_AI_GATEWAY_URL" ]; then
    # AI Gateway mode: all inference goes through the gateway. Hermes' custom
    # endpoint path takes its bearer from OPENAI_API_KEY, so the gateway token
    # is materialised under that name. Direct provider keys are deliberately
    # NOT written — the gateway owns upstream credentials.
    { [ -n "$HERMES_INFERENCE_TOKEN" ] && echo "OPENAI_API_KEY=$HERMES_INFERENCE_TOKEN" >> "$HERMES_ENV_FILE"; } || true
else
    { [ -n "$ANTHROPIC_API_KEY" ] && echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" >> "$HERMES_ENV_FILE"; } || true
    { [ -n "$OPENROUTER_API_KEY" ] && echo "OPENROUTER_API_KEY=$OPENROUTER_API_KEY" >> "$HERMES_ENV_FILE"; } || true
    { [ -n "$OPENAI_API_KEY" ] && echo "OPENAI_API_KEY=$OPENAI_API_KEY" >> "$HERMES_ENV_FILE"; } || true
fi
# Hermes' Notion integration reads NOTION_API_KEY from ~/.hermes/.env.
{ [ -n "$NOTION_TOKEN" ] && printf 'NOTION_API_KEY=%s\n' "$NOTION_TOKEN" >> "$HERMES_ENV_FILE"; } || true
# Telegram platform: the bot comes online only when BOTH the token and an
# allow-list are present. Without TELEGRAM_ALLOWED_USERS the bot is disabled
# at boot — anyone who finds an unlisted bot can drive it (and spend your
# provider credits), so an empty allow-list must not mean "public".
if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_ALLOWED_USERS" ]; then
    echo "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN" >> "$HERMES_ENV_FILE"
    echo "TELEGRAM_ALLOWED_USERS=$TELEGRAM_ALLOWED_USERS" >> "$HERMES_ENV_FILE"
elif [ -n "$TELEGRAM_BOT_TOKEN" ]; then
    echo "WARNING: TELEGRAM_BOT_TOKEN is set but TELEGRAM_ALLOWED_USERS is empty — Telegram bot DISABLED. Set TELEGRAM_ALLOWED_USERS (comma-separated numeric Telegram user ids) to enable it." >&2
fi
chmod 600 "$HERMES_ENV_FILE"
echo "[startup] wrote $HERMES_ENV_FILE ($(wc -l < "$HERMES_ENV_FILE") lines)" >> "$LOG_FILE"

# Bind to all interfaces. Cloudflare Sandbox `containerFetch` reaches the container via 10.0.0.1
# (external IP), not loopback. Hermes defaults to 127.0.0.1 which is unreachable from the Worker.
hermes config set API_SERVER_HOST 0.0.0.0 || hermes config set API_SERVER_BIND 0.0.0.0 || true

# Pin a default model so the API server can route requests when the caller does not specify one,
# or when the supplied model is not pre-registered with Hermes. Override with HERMES_DEFAULT_MODEL.
# In AI Gateway mode, route everything through the gateway as a custom endpoint:
#   https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/<provider>(/v1)  -> token = provider key (pass-through)
#   https://api.cloudflare.com/client/v4/accounts/<acct>/ai/v1        -> token = Cloudflare API token
# Model ids must match what the gateway's upstream expects. Workers AI models
# (@cf/...) on the REST API additionally require the cf-aig-gateway-id header;
# the OpenAI SDK reads it natively from OPENAI_CUSTOM_HEADERS, which covers
# every client Hermes constructs (main agent + auxiliary tasks).
if [ -n "$HERMES_AI_GATEWAY_URL" ]; then
    hermes config set model.provider custom || true
    hermes config set model.base_url "$HERMES_AI_GATEWAY_URL" || true
    hermes config set model.api_mode chat_completions || true
    hermes config set model.default "${HERMES_DEFAULT_MODEL:-@cf/zai-org/glm-5.3}" || true
    export OPENAI_CUSTOM_HEADERS="cf-aig-gateway-id: ${HERMES_AI_GATEWAY_ID:-default}"
else
    hermes config set model "${HERMES_DEFAULT_MODEL:-anthropic/claude-sonnet-4-5}" || true
fi

# Launch the native Hermes dashboard (web UI on port 9119) in the background.
# `--insecure` is required because Hermes refuses to bind 0.0.0.0 by default. This is safe in our
# topology: the container is unreachable from the public internet except through the Worker proxy,
# which is the only gate. See docs/architecture.md for details.
echo "=== $(date -u) launching hermes dashboard on 0.0.0.0:9119 ===" > "$DASHBOARD_LOG"
hermes dashboard --host 0.0.0.0 --port 9119 --insecure >> "$DASHBOARD_LOG" 2>&1 &
DASHBOARD_PID=$!
echo "Dashboard launched (pid=$DASHBOARD_PID)" >&2

# Launch the gateway in the foreground. Its stdout/stderr are tee'd to a log file the Worker can read.
echo "=== $(date -u) launching hermes gateway ===" >> "$LOG_FILE"
exec hermes gateway >> "$LOG_FILE" 2>&1
