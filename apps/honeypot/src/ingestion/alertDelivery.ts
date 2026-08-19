import nodemailer from "nodemailer";
import { createWebhookAdapter, createSlackAdapter, type AlertDeliveryAdapter } from "@honeypot/detection";
import { config } from "../config.js";

function createEmailAdapter(email: NonNullable<typeof config.alertEmail>): AlertDeliveryAdapter {
  const transport = nodemailer.createTransport({
    host: email.host,
    port: email.port,
    secure: email.port === 465,
    auth: email.user ? { user: email.user, pass: email.password } : undefined,
  });

  return {
    name: "email",
    async deliver(alert) {
      await transport.sendMail({
        to: email.to,
        from: email.from,
        subject: `[${alert.severity.toUpperCase()}] ${alert.title}`,
        text: `${alert.description}\n\nActor: ${alert.actorId}\nRule: ${alert.ruleId}\nTriggered: ${alert.triggeredAt}\n\n${JSON.stringify(alert.metadata, null, 2)}`,
      });
    },
  };
}

/** Built once at startup from whatever's configured in .env — see docs/ROADMAP.md Phase 2. */
export function buildAlertAdapters(): AlertDeliveryAdapter[] {
  const adapters: AlertDeliveryAdapter[] = [];
  if (config.alertWebhookUrl) adapters.push(createWebhookAdapter(config.alertWebhookUrl));
  if (config.alertSlackWebhookUrl) adapters.push(createSlackAdapter(config.alertSlackWebhookUrl));
  if (config.alertEmail) adapters.push(createEmailAdapter(config.alertEmail));
  return adapters;
}
