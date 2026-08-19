/**
 * Path signatures commonly probed by opportunistic scanners and recon tooling.
 * See docs/DETECTION.md §2 (Tier 1) and docs/ATTACK_SURFACE.md.
 */
const RECON_SIGNATURES: RegExp[] = [
  /\.env$/i,
  /\.git\//i,
  /\.aws\//i,
  /id_rsa$/i,
  /wp-admin/i,
  /wp-login\.php/i,
  /phpmyadmin/i,
  /\.htaccess$/i,
  /\.htpasswd$/i,
  /backup.*\.(zip|tar|sql|gz)$/i,
  /config\.(php|json|yml|yaml)\.bak$/i,
  /docker-compose\.ya?ml$/i,
  /\.dockerenv$/i,
  /server-status$/i,
  /actuator(\/.*)?$/i,
  /debug$/i,
  /console$/i,
  /vendor\/phpunit/i,
  /\.well-known\/(?!security\.txt)/i,
];

export function matchesReconSignature(path: string): boolean {
  return RECON_SIGNATURES.some((re) => re.test(path));
}
