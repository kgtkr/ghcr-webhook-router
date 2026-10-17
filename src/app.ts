import { Hono } from "hono";
import type { AppConfig } from "./config.ts";
import { verifyWebhookSignature, createGitHubClient, type GitHubClient } from "./auth.ts";
import { processWebhook, type WebhookPayload } from "./router.ts";

export function createApp(config: AppConfig, clientOrFetch?: GitHubClient | typeof fetch): Hono {
  const app = new Hono();
  const client: GitHubClient =
    clientOrFetch && typeof clientOrFetch === "object" && "dispatch" in clientOrFetch
      ? clientOrFetch
      : createGitHubClient(config, typeof clientOrFetch === "function" ? clientOrFetch : undefined);

  app.get("/healthz", (c) => c.text("OK"));

  app.post("/webhook", async (c) => {
    const signature = c.req.header("x-hub-signature-256");
    const eventHeader = c.req.header("x-github-event");
    const rawBody = await c.req.text();

    const isValid = await verifyWebhookSignature(rawBody, signature, config.WEBHOOK_SECRET);
    if (!isValid) {
      console.warn(`[webhook] Invalid signature (event=${eventHeader ?? "unknown"})`);
      return c.json({ error: "Invalid signature" }, 401);
    }

    let payload: WebhookPayload;
    try {
      payload = JSON.parse(rawBody) as WebhookPayload;
    } catch {
      console.warn(`[webhook] Invalid JSON payload (event=${eventHeader ?? "unknown"})`);
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const result = await processWebhook(eventHeader, payload, config, client);

    const hasErrors = result.targets?.some((t) => !t.ok);
    if (hasErrors) {
      console.error(
        `[webhook] Dispatch failed for ${result.image ?? "unknown"}:${result.tag ?? "unknown"}:`,
        JSON.stringify(result.targets),
      );
    } else if (result.dispatched) {
      console.log(
        `[webhook] Dispatched ${result.image}:${result.tag} -> ${result.targets?.map((t) => t.repo).join(", ")}`,
      );
    } else {
      console.log(
        `[webhook] Skipped (event=${eventHeader ?? "unknown"}${result.image ? `, image=${result.image}` : ""}${result.tag ? `, tag=${result.tag}` : ""}): ${result.message}`,
      );
    }

    const status = hasErrors ? 502 : 200;

    return c.json(result, status);
  });

  return app;
}
