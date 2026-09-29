/**
 * Redacts values of secret-looking keys (`API_SERVER_KEY`, `*_TOKEN`,
 * `*_API_KEY`, `*_SECRET`, ...) from raw container output before it is
 * logged or embedded in error responses. Anything returning process/log/
 * config output — or building an Error message from container stderr —
 * must pass through `redactSecrets`.
 */
const SECRET_KEY_RE =
  /((?:[A-Za-z0-9_]*)(?:API_KEY|SERVER_KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*)\s*[=:]\s*\S+/g;

export function redactSecrets(output: string): string {
  return output.replace(SECRET_KEY_RE, '$1=<redacted>');
}
