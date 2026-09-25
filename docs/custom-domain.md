# Custom domain (native dashboard)

By default `hermesworkers` is reachable at its `*.workers.dev` URL and exposes only the API endpoints (`/v1/chat/completions`, `/api/*`). The native Hermes dashboard — the React UI with the sessions / analytics / cron / skills tabs — is **not** served on that URL because its absolute-path assets only resolve when it owns an entire hostname.

This guide wires a dedicated hostname (e.g. `hermes.example.com`) to the dashboard.

## Prerequisites

- You own a domain that is already on Cloudflare DNS (the nameservers point to Cloudflare).
- You can edit DNS records and Worker routes for that zone.

## 1. Pick a hostname

Anything you control works. Examples:

- `hermes.example.com` (a single label, fully covered by Cloudflare's free Universal SSL).
- `agent.example.com`.
- `chat.example.com`.

For the rest of this guide we use `hermes.example.com`.

## 2. Add DNS

In the Cloudflare dashboard for the zone:

1. **DNS → Records → Add record.**
2. Type `CNAME`, Name `hermes`, Target your Worker's `*.workers.dev` URL (or any valid record — the target value only matters when there's no matching Worker Route, which won't be the case here).
3. **Proxy status: Proxied** (orange cloud).
4. Save.

## 3. Tell the Worker about the hostname

Edit `wrangler.local.toml` (your git-ignored deployment config):

```toml
[vars]
DASHBOARD_HOSTNAME = "hermes.example.com"

routes = [
  { pattern = "hermes.example.com", custom_domain = true }
]
```

`custom_domain = true` tells Cloudflare to auto-provision the hostname as a Worker Custom Domain (SSL handled for you). Note the pattern is the bare hostname — Custom Domains do not accept a `/*` path wildcard.

## 4. Redeploy

```bash
npm run deploy
```

## 5. Verify

```bash
curl -I https://hermes.example.com/ \
  -H "Authorization: Bearer $API_TOKEN"
```

You should get back the Hermes dashboard HTML (HTTP 200, `content-type: text/html`). Visiting the URL in a browser shows the dashboard with the sidebar (Sessions, Analytics, Models, Cron, Skills, etc.).

If `API_TOKEN` is set, the dashboard hostname requires a credential. Three are accepted:

- **Zero Trust SSO (recommended):** if the hostname is fronted by a Cloudflare Access application, set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.local.toml` `[vars]`. The Worker validates the `Cf-Access-Jwt-Assertion` the edge injects after SSO — the browser flow is simply: open the URL, authenticate to Access, done. Nothing to paste or save.
- **Login page (fallback):** open `https://hermes.example.com/dashboard-login`, paste the token, and sign in. This sets an `HttpOnly` `hw_token` cookie (30 days) and redirects to the dashboard. Browsers that fail the gate are redirected here automatically.
- **Header:** send `Authorization: Bearer <token>` (curl / API clients).

### Enabling the Zero Trust path

1. Ensure an Access application covers the hostname (Zero Trust → Access controls → Applications).
2. Copy the application's **AUD tag** (Configure → Additional settings).
3. Add to `wrangler.local.toml`:
   ```toml
   [vars]
   ACCESS_TEAM_DOMAIN = "<your-team>.cloudflareaccess.com"
   ACCESS_AUD = "<application AUD tag>"
   ```
4. Redeploy. The Worker fetches the team's public keys from
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` and verifies
   each request's JWT (signature, issuer, audience, expiry) — key rotation
   is handled by re-fetching the JWKS on an unknown `kid`.

## Common issues

**`ERR_SSL_VERSION_OR_CIPHER_MISMATCH`** in the browser.
Cloudflare's free Universal SSL covers `example.com` and one wildcard level `*.example.com`. A hostname two levels deep like `a.b.example.com` is **not** covered. Either pick a single-label hostname (`hermes.example.com`) or order an Advanced Certificate for the deeper pattern.

**`526 Invalid SSL certificate`** from Cloudflare.
Make sure `custom_domain = true` is set in the route — the standard Worker Route pattern requires the certificate to be managed elsewhere. Custom Domains use Cloudflare-managed SSL automatically.

**Dashboard shows the Hermes "Connect" form instead of loading directly.**
The Hermes dashboard requires a gateway token over WebSocket. `hermesworkers` auto-injects it when the request comes in over the configured `DASHBOARD_HOSTNAME` — if you reach the dashboard via a different URL (e.g. the raw `*.workers.dev` URL), the injection won't fire and the form will appear.

**WebSocket fails to connect (1006 disconnected).**
Confirm the hostname is registered as a Worker Custom Domain (not a regular Worker Route). Custom Domains preserve WebSocket upgrades by default; some Worker Route configurations don't.
