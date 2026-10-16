import { Hono } from 'hono';
import {
  getContainer,
  collectProviderKeys,
  collectR2Durability,
  type Env,
} from '../lib/container';
import { ensureGateway, runBackup } from '../services/container-lifecycle';
import { timingSafeEqualStr } from '../lib/auth';

/**
 * Telegram webhook endpoint.
 *
 * In webhook mode Hermes does not poll Telegram; Telegram pushes updates
 * here. The path MUST match the one in TELEGRAM_WEBHOOK_URL (Hermes
 * auto-extracts it and registers the webhook with Telegram) — keep both set
 * to /telegram.
 *
 * This route is intentionally outside the /v1/* and /api/* bearer-token
 * gates: Telegram cannot present the Worker's API_TOKEN. Its own credential
 * is the X-Telegram-Bot-Api-Secret-Token header, verified constant-time
 * against TELEGRAM_WEBHOOK_SECRET before anything else happens — and Hermes
 * verifies the same header again inside the container (GHSA-3vpc-7q5r-276h).
 *
 * The request also serves as the wake path: ensureGateway boots the
 * container (R2 mount + state restore + gateway) if it is asleep, so a
 * message to the bot is answered even from a cold start. Telegram retries
 * deliveries that time out, and Hermes deduplicates by update_id, so a
 * slow cold wake cannot lose or double-process a message.
 */
const TELEGRAM_WEBHOOK_PORT = 8443;

const telegram = new Hono<{ Bindings: Env }>();

telegram.post('/telegram', async (c) => {
  const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    return c.json({ error: 'telegram_webhook_not_configured' }, 503);
  }
  const header = c.req.header('x-telegram-bot-api-secret-token') ?? '';
  if (!header || !(await timingSafeEqualStr(header, secret))) {
    return new Response('Forbidden', { status: 403 });
  }

  const container = getContainer(c.env);
  try {
    await ensureGateway(container, {
      providerKeys: collectProviderKeys(c.env),
      gatewayToken: c.env.HERMES_GATEWAY_TOKEN,
      defaultModel: c.env.HERMES_DEFAULT_MODEL,
      r2: collectR2Durability(c.env),
    });
  } catch (err) {
    console.error('[telegram-webhook] gateway unavailable:', err);
    return new Response('Container not ready', { status: 503 });
  }

  // Forward the update verbatim to Hermes' webhook server (same path), with
  // the secret header preserved for Hermes' own verification pass.
  const body = await c.req.text();
  const upstream = new Request(
    `http://localhost:${TELEGRAM_WEBHOOK_PORT}${new URL(c.req.url).pathname}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': c.req.header('content-type') ?? 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': header,
      },
      body,
    },
  );

  let response: Response;
  try {
    response = await (container as any).containerFetch(
      upstream,
      TELEGRAM_WEBHOOK_PORT,
    );
  } catch (err) {
    console.error('[telegram-webhook] forward failed:', err);
    return new Response('Webhook upstream unavailable', { status: 502 });
  }

  // Telegram traffic deserves the same debounced ~/.hermes backup as the
  // chat API — otherwise Telegram-only usage never snapshots state.
  const r2 = collectR2Durability(c.env);
  if (r2) {
    c.executionCtx.waitUntil(
      runBackup(container, r2).catch((err) =>
        console.error('[r2-backup] post-telegram backup failed (non-fatal):', err),
      ),
    );
  }

  // Telegram only needs a 2xx; pass Hermes' status and body through.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
});

export { telegram };
