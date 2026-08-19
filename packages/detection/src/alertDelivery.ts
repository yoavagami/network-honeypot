/**
 * Alert delivery — see docs/ROADMAP.md Phase 2, brief §36. Every adapter is best-effort: a
 * failing or unreachable delivery target must never break alert *recording* (the
 * ALERT_TRIGGERED event is always persisted regardless — see apps/honeypot/src/ingestion/alerts.ts),
 * and one adapter failing must never block the others.
 */
export interface AlertPayload {
  ruleId: string;
  severity: "high" | "critical";
  title: string;
  description: string;
  actorId: string;
  metadata: Record<string, unknown>;
  triggeredAt: string;
}

export interface AlertDeliveryAdapter {
  readonly name: string;
  deliver(alert: AlertPayload): Promise<void>;
}

/** Generic webhook — POSTs the alert as JSON. Works with anything that accepts a JSON body
 * (a custom endpoint, most alerting/on-call tools' generic webhook intake). */
export function createWebhookAdapter(url: string): AlertDeliveryAdapter {
  return {
    name: "webhook",
    async deliver(alert) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(alert),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`webhook delivery failed: ${res.status}`);
    },
  };
}

/** Slack incoming webhook — https://api.slack.com/messaging/webhooks. Same idea as the generic
 * webhook but formatted for Slack's expected {text} shape. */
export function createSlackAdapter(webhookUrl: string): AlertDeliveryAdapter {
  return {
    name: "slack",
    async deliver(alert) {
      const text = [
        `*[${alert.severity.toUpperCase()}] ${alert.title}*`,
        alert.description,
        `Actor: \`${alert.actorId}\``,
        Object.keys(alert.metadata).length ? "```" + JSON.stringify(alert.metadata, null, 2) + "```" : null,
      ]
        .filter(Boolean)
        .join("\n");

      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`slack delivery failed: ${res.status}`);
    },
  };
}

/** Delivers to every configured adapter, best-effort — one failing never stops the others, and
 * failures are returned (not thrown) so the caller can log them without the alert pipeline
 * itself ever throwing. */
export async function deliverToAll(adapters: AlertDeliveryAdapter[], alert: AlertPayload): Promise<Array<{ adapter: string; error: string }>> {
  const failures: Array<{ adapter: string; error: string }> = [];
  await Promise.all(
    adapters.map(async (adapter) => {
      try {
        await adapter.deliver(alert);
      } catch (err) {
        failures.push({ adapter: adapter.name, error: err instanceof Error ? err.message : String(err) });
      }
    })
  );
  return failures;
}
