import { Hono } from "hono";
import type { AppConfig } from "./config.ts";
import { verifyWebhookSignature } from "./auth.ts";
import { processWebhook, type PackageWebhookPayload } from "./router.ts";

export function createApp(config: AppConfig, fetchFn: typeof fetch = fetch): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.text("OK"));

  app.post("/webhook", async (c) => {
    const signature = c.req.header("x-hub-signature-256");
    const eventHeader = c.req.header("x-github-event");
    const rawBody = await c.req.text();

    if (!verifyWebhookSignature(rawBody, signature, config.WEBHOOK_SECRET)) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    let payload: PackageWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as PackageWebhookPayload;
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const result = await processWebhook(eventHeader, payload, config, fetchFn);

    const hasErrors = result.targets?.some((t) => !t.ok);
    const status = hasErrors ? 502 : 200;

    return c.json(result, status);
  });

  return app;
}
