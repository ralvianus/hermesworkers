/**
 * Cloudflare Access JWT validation.
 *
 * When a hostname is fronted by a Cloudflare Access application, the edge
 * injects a signed JWT into the `Cf-Access-Jwt-Assertion` header of every
 * authenticated request. Validating it lets the Worker trust the user's
 * Access identity (SSO) as the credential instead of a shared token.
 *
 * Verification per:
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 *   - signature: RS256 against the team's JWKS
 *     (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`)
 *   - claims:    iss, aud (app AUD tag), exp (and nbf when present)
 *
 * Access rotates its signing key every ~6 weeks; the previous key stays
 * valid for 7 days after rotation. The JWKS is cached for one hour and
 * re-fetched on demand when a JWT carries an unknown `kid`.
 */

interface AccessJwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

interface AccessJwtHeader {
  kid: string;
  alg: string;
}

interface AccessJwtPayload {
  iss: string;
  aud: string;
  sub: string;
  email?: string;
  exp: number;
  iat?: number;
  nbf?: number;
}

const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache: { teamDomain: string; keys: AccessJwk[]; fetchedAt: number } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  let normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64urlToJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as T;
}

async function fetchAccessJwks(teamDomain: string, forceRefresh = false): Promise<AccessJwk[]> {
  const cached = jwksCache;
  if (
    !forceRefresh &&
    cached &&
    cached.teamDomain === teamDomain &&
    Date.now() - cached.fetchedAt < JWKS_TTL_MS
  ) {
    return cached.keys;
  }

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  const data = (await res.json()) as { keys?: AccessJwk[] };
  const keys = data.keys ?? [];
  jwksCache = { teamDomain, keys, fetchedAt: Date.now() };
  return keys;
}

async function verifyRs256Signature(
  jwt: string,
  jwk: AccessJwk,
): Promise<boolean> {
  const [headerPart, payloadPart, sigPart] = jwt.split('.');
  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, alg: 'RS256', n: jwk.n, e: jwk.e },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signature = b64urlToBytes(sigPart);
  const signedContent = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signedContent);
}

/**
 * Returns true when `jwt` (the Cf-Access-Jwt-Assertion value) is a valid,
 * unexpired Access token issued by `teamDomain` for the application whose
 * AUD tag is `aud`. Any missing input fails closed.
 */
export async function isValidAccessJwt(
  jwt: string | null,
  teamDomain: string,
  aud: string,
): Promise<boolean> {
  if (!jwt || !teamDomain || !aud) return false;
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return false;
    const header = b64urlToJson<AccessJwtHeader>(parts[0]);
    const payload = b64urlToJson<AccessJwtPayload>(parts[1]);

    if (payload.iss !== `https://${teamDomain}`) return false;
    if (payload.aud !== aud) return false;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) return false;
    if (payload.nbf && payload.nbf > now) return false;

    let keys = await fetchAccessJwks(teamDomain);
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      // Unknown kid — the signing key may have rotated; refetch once.
      keys = await fetchAccessJwks(teamDomain, true);
      jwk = keys.find((k) => k.kid === header.kid);
      if (!jwk) return false;
    }

    return verifyRs256Signature(jwt, jwk);
  } catch {
    return false;
  }
}
