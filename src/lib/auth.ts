/**
 * Auth helpers shared by the API gate and the dashboard proxy.
 */

const encoder = new TextEncoder();

/**
 * Constant-time string comparison to prevent timing attacks on the
 * bearer-token gates. Both values are SHA-256 hashed first so the
 * comparison length never leaks information about the token length.
 */
export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  // crypto.subtle.timingSafeEqual is a Cloudflare Workers extension.
  return (crypto.subtle as any).timingSafeEqual(ha, hb);
}

/**
 * Extracts a bearer token from an Authorization header, or '' when absent.
 */
export function bearerFromHeader(headerValue: string | null): string {
  const header = headerValue || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}
