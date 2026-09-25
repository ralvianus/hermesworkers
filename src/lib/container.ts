import type { HermesInstance } from '../hermesContainer';

/**
 * Bindings exposed to the Worker via wrangler.toml.
 *
 * Required secrets:
 *   - One of ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY
 * Optional secrets:
 *   - API_TOKEN              bearer token required on /api/* if set
 *   - HERMES_GATEWAY_TOKEN   bearer token between Worker and Hermes API server
 *   - HERMES_DEFAULT_MODEL   default model id (e.g. `anthropic/claude-sonnet-4-5`)
 * Vars (wrangler.toml [vars]):
 *   - DASHBOARD_HOSTNAME     hostname proxied to the dashboard (port 9119)
 *   - ACCESS_TEAM_DOMAIN     Cloudflare Zero Trust team domain, e.g. myteam.cloudflareaccess.com
 *   - ACCESS_AUD             AUD tag of the Access application in front of DASHBOARD_HOSTNAME
 *                            (dashboard requests carrying a valid Access JWT bypass API_TOKEN)
 */
export interface Env {
  HERMES: DurableObjectNamespace<HermesInstance>;

  ANTHROPIC_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;

  API_TOKEN?: string;
  HERMES_GATEWAY_TOKEN?: string;
  HERMES_DEFAULT_MODEL?: string;
  DASHBOARD_HOSTNAME?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;

  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALLOWED_USERS?: string;

  // AI Gateway mode: when set, all inference routes through this base URL
  // (Cloudflare AI Gateway) instead of direct providers. Model ids must match
  // what the gateway's provider expects.
  HERMES_AI_GATEWAY_URL?: string;
  // Bearer token Hermes sends to the gateway (kept out of .dev-repos; stored
  // as a Worker secret). For gateway.ai.cloudflare.com pass-through this is
  // the provider key; for the /ai/v1 REST API it is a Cloudflare API token.
  HERMES_INFERENCE_TOKEN?: string;
  // AI Gateway id sent as cf-aig-gateway-id (required for @cf/ models on the
  // REST API; "default" targets the account's auto-created gateway).
  HERMES_AI_GATEWAY_ID?: string;
}

/**
 * Returns the single-tenant Durable Object stub for this deployment.
 * The deterministic name (`main`) means every request resolves to the same container.
 */
export function getContainer(env: Env): DurableObjectStub<HermesInstance> {
  const id = env.HERMES.idFromName('main');
  return env.HERMES.get(id);
}

/**
 * Collect the env vars that must land in the container's ~/.hermes/.env:
 * BYOK provider keys plus optional gateway platform config (Telegram).
 * The startup script materialises .env from scratch on every boot, so
 * every gateway-visible variable has to be injected through here.
 */
export function collectProviderKeys(env: Env): Record<string, string> {
  const keys: Record<string, string> = {};
  if (env.ANTHROPIC_API_KEY) keys.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  if (env.OPENROUTER_API_KEY) keys.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
  if (env.OPENAI_API_KEY) keys.OPENAI_API_KEY = env.OPENAI_API_KEY;
  if (env.TELEGRAM_BOT_TOKEN) keys.TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  if (env.TELEGRAM_ALLOWED_USERS) keys.TELEGRAM_ALLOWED_USERS = env.TELEGRAM_ALLOWED_USERS;
  if (env.HERMES_AI_GATEWAY_URL) keys.HERMES_AI_GATEWAY_URL = env.HERMES_AI_GATEWAY_URL;
  if (env.HERMES_INFERENCE_TOKEN) keys.HERMES_INFERENCE_TOKEN = env.HERMES_INFERENCE_TOKEN;
  if (env.HERMES_AI_GATEWAY_ID) keys.HERMES_AI_GATEWAY_ID = env.HERMES_AI_GATEWAY_ID;
  return keys;
}
