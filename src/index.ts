import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";

export const config = loadConfig();
export const app = createApp(config);

if (process.env.NODE_ENV !== "test") {
  serve(
    {
      fetch: app.fetch,
      port: config.PORT,
    },
    (info) => {
      console.log(`ghcr-webhook-router running at http://localhost:${info.port}`);
    },
  );
}
