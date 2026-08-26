/**
 * Known webshell/backdoor filenames — the pattern real mass-compromise campaigns use (a PHP file
 * disguised inside an asset directory, or a famous named shell family). Deliberately not linked
 * anywhere on the site (no nav, no sitemap, no docs) — unlike the CRM search feature, the
 * realism model here is "the attacker already knows this filename from their own external
 * intel," not "found it by browsing." See docs/VULNERABILITY.md.
 */
export const BACKDOOR_PATHS = new Set([
  "/css/database.php",
  "/wp-admin/css/index.php",
  "/wp-content/uploads/2023/logo.php",
  "/wp-includes/js/jquery/jquery.php",
  "/images/thumb.php",
  "/assets/style.php",
  "/c99.php",
  "/r57.php",
  "/wso.php",
  "/alfa.php",
  "/shell.php",
  "/wp-content/plugins/akismet/akismet.php.suspected",
]);

export function isBackdoorPath(path: string): boolean {
  return BACKDOOR_PATHS.has(path);
}
