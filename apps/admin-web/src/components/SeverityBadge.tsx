const KNOWN = new Set(["info", "low", "medium", "high", "critical"]);

export function SeverityBadge({ severity }: { severity: string | null | undefined }) {
  const s = severity && KNOWN.has(severity) ? severity : "info";
  return <span className={`badge ${s}`}>{s}</span>;
}

export function riskToSeverity(risk: number): string {
  if (risk >= 80) return "critical";
  if (risk >= 60) return "high";
  if (risk >= 35) return "medium";
  if (risk >= 15) return "low";
  return "info";
}
