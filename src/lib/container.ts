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
  // Explicit opt-out of the fail-closed default: when 'true', /api/*, /v1/*
  // and the dashboard are served with no credential (local dev only).
  ALLOW_UNAUTHENTICATED?: string;
  HERMES_GATEWAY_TOKEN?: string;
  HERMES_DEFAULT_MODEL?: string;
  DASHBOARD_HOSTNAME?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;

  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALLOWED_USERS?: string;
  NOTION_TOKEN?: string;

  // ── R2 state durability (optional) ────────────────────────────────
  // Enabled when all of: HERMES_R2_ENDPOINT + BACKUP_BUCKET_NAME +
  // CLOUDFLARE_ACCOUNT_ID vars, R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
  // secrets, and the BACKUP_BUCKET R2 binding (name required by the Sandbox
  // SDK's backup API) are set. Memories are s3fs-mounted from the bucket;
  // ~/.hermes is periodically snapshotted into it.
  // See docs/plans/r2-durability-plan.md.
  BACKUP_BUCKET?: R2Bucket;
  HERMES_R2_ENDPOINT?: string;
  BACKUP_BUCKET_NAME?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  HERMES_BACKUP_INTERVAL_SEC?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;

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
 * BYOK provider keys plus optional gateway platform config (Telegram, Notion).
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
  if (env.NOTION_TOKEN) keys.NOTION_TOKEN = env.NOTION_TOKEN;
  if (env.HERMES_AI_GATEWAY_URL) keys.HERMES_AI_GATEWAY_URL = env.HERMES_AI_GATEWAY_URL;
  if (env.HERMES_INFERENCE_TOKEN) keys.HERMES_INFERENCE_TOKEN = env.HERMES_INFERENCE_TOKEN;
  if (env.HERMES_AI_GATEWAY_ID) keys.HERMES_AI_GATEWAY_ID = env.HERMES_AI_GATEWAY_ID;
  return keys;
}

/**
 * R2 durability configuration, resolved from the Worker bindings/secrets.
 * Returns undefined (feature off) unless every required piece is present —
 * deployments that have not opted in keep working exactly as before.
 */
export interface R2Durability {
  /** S3 endpoint, e.g. https://<account-id>.r2.cloudflarestorage.com */
  endpoint: string;
  /** Bucket that holds memories/ + backups/ */
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 binding handle (BACKUP_BUCKET) — used for pruning retired backup
   *  objects and for local-dev localBucket mounts. */
  bucket?: R2Bucket;
  /** Post-chat backup debounce, seconds (default 900 = 15 min). */
  backupIntervalSec: number;
}

/** R2 S3 endpoints — plain or jurisdiction-specific (e.g. .eu.). */
const R2_ENDPOINT_RE = /^https:\/\/[a-z0-9-]+(\.eu)?\.r2\.cloudflarestorage\.com\/?$/i;

export function collectR2Durability(env: Env): R2Durability | undefined {
  const configured =
    !!env.HERMES_R2_ENDPOINT &&
    !!env.BACKUP_BUCKET_NAME &&
    !!env.CLOUDFLARE_ACCOUNT_ID &&
    !!env.R2_ACCESS_KEY_ID &&
    !!env.R2_SECRET_ACCESS_KEY;
  if (!configured || !env.BACKUP_BUCKET) {
    // Warn when ANY piece is present but the feature can't engage, so a
    // half-configured deployment is visible in logs instead of silently off.
    const partial =
      env.HERMES_R2_ENDPOINT ||
      env.BACKUP_BUCKET_NAME ||
      env.CLOUDFLARE_ACCOUNT_ID ||
      env.R2_ACCESS_KEY_ID ||
      env.R2_SECRET_ACCESS_KEY;
    if (partial) {
      console.warn(
        '[r2] R2 durability config is incomplete — memory mount + backups ' +
          'disabled. Check HERMES_R2_ENDPOINT, BACKUP_BUCKET_NAME, CLOUDFLARE_ACCOUNT_ID, ' +
          'R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and the BACKUP_BUCKET binding.',
      );
    }
    return undefined;
  }
  // The endpoint receives the R2 token credentials in the S3 auth exchange —
  // refuse anything that is not a real R2 S3 endpoint.
  if (!R2_ENDPOINT_RE.test(env.HERMES_R2_ENDPOINT!)) {
    console.warn(
      '[r2] HERMES_R2_ENDPOINT is not a valid R2 S3 endpoint — R2 durability disabled.',
    );
    return undefined;
  }
  return {
    endpoint: env.HERMES_R2_ENDPOINT!,
    bucketName: env.BACKUP_BUCKET_NAME!,
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    bucket: env.BACKUP_BUCKET,
    backupIntervalSec: Number(env.HERMES_BACKUP_INTERVAL_SEC ?? '900') || 900,
  };
}
