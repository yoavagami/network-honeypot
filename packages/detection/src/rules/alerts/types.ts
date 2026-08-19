export interface AlertMatch {
  ruleId: string;
  severity: "high" | "critical";
  title: string;
  description: string;
  metadata: Record<string, unknown>;
}
