/**
 * Fixed, hardcoded dictionary of recognized recon commands -> fake output. Matching is prefix-
 * based against a small curated list, nothing is executed, evaluated, or interpolated from the
 * request — this is the entire safety boundary. Unrecognized input gets empty output, matching
 * how a real minimal shell behaves on a garbage command. See docs/VULNERABILITY.md.
 */
const FAKE_COMMANDS: Array<{ family: string; match: (input: string) => boolean; output: string }> = [
  { family: "whoami", match: (i) => i === "whoami", output: "www-data" },
  { family: "id", match: (i) => i === "id", output: "uid=33(www-data) gid=33(www-data) groups=33(www-data)" },
  { family: "uname", match: (i) => i.startsWith("uname"), output: "Linux web-prod-03 5.15.0-91-generic #101-Ubuntu SMP x86_64 GNU/Linux" },
  { family: "pwd", match: (i) => i === "pwd", output: "/var/www/html" },
  { family: "hostname", match: (i) => i === "hostname", output: "web-prod-03" },
  {
    family: "ls",
    match: (i) => i.startsWith("ls"),
    output: "index.php\nwp-config.php\n.htaccess\ncss/\nwp-admin/\nwp-content/\nwp-includes/",
  },
  {
    family: "cat_passwd",
    match: (i) => i.includes("/etc/passwd"),
    output: "root:x:0:0:root:/root:/bin/bash\nwww-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\nmysql:x:114:120:MySQL Server:/nonexistent:/bin/false",
  },
  { family: "ps", match: (i) => i.startsWith("ps"), output: "  PID TTY          TIME CMD\n    1 ?        00:00:02 nginx\n   34 ?        00:00:01 php-fpm8.1" },
  { family: "phpinfo", match: (i) => i.includes("phpinfo"), output: "PHP Version 8.1.27\nServer API: FPM/FastCGI" },
  { family: "echo", match: (i) => i.startsWith("echo "), output: "" }, // handled specially — see resolveFakeCommand
];

export interface FakeCommandResult {
  family: string;
  output: string;
}

export function resolveFakeCommand(rawInput: string): FakeCommandResult | null {
  const input = rawInput.trim().toLowerCase();
  if (!input) return null;
  if (input.startsWith("echo ")) {
    // Real shells echo back their argument — safe to do here too, it's a fixed transform of
    // input into output text, never interpreted as anything.
    return { family: "echo", output: rawInput.trim().slice(5) };
  }
  const match = FAKE_COMMANDS.find((c) => c.match(input));
  return match ? { family: match.family, output: match.output } : null;
}
