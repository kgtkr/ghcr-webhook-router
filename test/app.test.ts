import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import crypto from "node:crypto";
import { createApp } from "../src/app.ts";
import type { AppConfig } from "../src/config.ts";
import { clearDebounceCache } from "../src/router.ts";
import { clearTokenCache } from "../src/auth.ts";

function sign(body: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(body);
  return `sha256=${hmac.digest("hex")}`;
}

describe("ghcr-webhook-router", () => {
  const secret = "test-secret-1234";
  const baseConfig: AppConfig = {
    PORT: 3000,
    WEBHOOK_SECRET: secret,
    TARGET_REPOS: ["kgtkr/public-cd"],
    DISPATCH_EVENT_TYPE: "ghcr_package_published",
    GITHUB_TOKEN: "mock-token-xyz",
    TAG_EXCLUDE_REGEX: /-(amd64|arm64)$/,
    DEBOUNCE_MS: 5000,
  };

  beforeEach(() => {
    clearDebounceCache();
    clearTokenCache();
    vi.restoreAllMocks();
  });

  it("responds OK on GET /healthz", async () => {
    const app = createApp(baseConfig);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  it("rejects POST /webhook with missing or invalid signature", async () => {
    const app = createApp(baseConfig);
    const body = JSON.stringify({ action: "published" });

    const res1 = await app.request("/webhook", {
      method: "POST",
      body,
    });
    expect(res1.status).toBe(401);

    const res2 = await app.request("/webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=invalid" },
      body,
    });
    expect(res2.status).toBe(401);
  });

  it("handles ping event with pong", async () => {
    const app = createApp(baseConfig);
    const body = JSON.stringify({ zen: "Responsive is better than fast." });
    const signature = sign(body, secret);

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "x-hub-signature-256": signature,
        "x-github-event": "ping",
        "content-type": "application/json",
      },
      body,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ dispatched: false, message: "Pong" });
  });

  it("ignores non-container package published events", async () => {
    const app = createApp(baseConfig);
    const body = JSON.stringify({
      action: "published",
      package: {
        name: "test-npm",
        package_type: "npm",
        owner: { login: "kgtkr" },
      },
    });
    const signature = sign(body, secret);

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "x-hub-signature-256": signature,
        "x-github-event": "package",
        "content-type": "application/json",
      },
      body,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.dispatched).toBe(false);
    expect(data.message).toContain("Ignored package_type");
  });

  it("ignores untagged manifest published events", async () => {
    const app = createApp(baseConfig);
    const body = JSON.stringify({
      action: "published",
      package: {
        name: "kgtkr.net",
        package_type: "container",
        owner: { login: "kgtkr" },
        package_version: {
          version: "sha256:123456",
          container_metadata: {},
        },
      },
    });
    const signature = sign(body, secret);

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "x-hub-signature-256": signature,
        "x-github-event": "package",
        "content-type": "application/json",
      },
      body,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.dispatched).toBe(false);
    expect(data.message).toBe("Untagged manifest, ignored");
  });

  it("ignores tags matching TAG_EXCLUDE_REGEX", async () => {
    const app = createApp(baseConfig);
    const body = JSON.stringify({
      action: "published",
      package: {
        name: "kgtkr.net",
        package_type: "container",
        owner: { login: "kgtkr" },
        package_version: {
          version: "sha256:123456",
          container_metadata: {
            tag: { name: "20261017-sha-amd64" },
          },
        },
      },
    });
    const signature = sign(body, secret);

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "x-hub-signature-256": signature,
        "x-github-event": "package",
        "content-type": "application/json",
      },
      body,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.dispatched).toBe(false);
    expect(data.message).toContain("TAG_EXCLUDE_REGEX");
  });

  it("dispatches successfully to TARGET_REPOS for valid container tag", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      text: async () => "",
    });

    const app = createApp(baseConfig, mockFetch as unknown as typeof fetch);
    const body = JSON.stringify({
      action: "published",
      package: {
        name: "kgtkr.net",
        package_type: "container",
        owner: { login: "kgtkr" },
        package_version: {
          version: "sha256:abcdef",
          container_metadata: {
            tag: { name: "20261017-8d3e086" },
          },
        },
      },
    });
    const signature = sign(body, secret);

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "x-hub-signature-256": signature,
        "x-github-event": "package",
        "content-type": "application/json",
      },
      body,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.dispatched).toBe(true);
    expect(data.image).toBe("ghcr.io/kgtkr/kgtkr.net");
    expect(data.tag).toBe("20261017-8d3e086");
    expect(data.targets).toHaveLength(1);
    expect(data.targets[0]).toEqual({
      repo: "kgtkr/public-cd",
      ok: true,
      status: 204,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/kgtkr/public-cd/dispatches",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer mock-token-xyz",
          Accept: "application/vnd.github+json",
        }),
        body: JSON.stringify({
          event_type: "ghcr_package_published",
          client_payload: {
            registry: "ghcr.io",
            owner: "kgtkr",
            package: "kgtkr.net",
            image: "ghcr.io/kgtkr/kgtkr.net",
            tag: "20261017-8d3e086",
            digest: "sha256:abcdef",
          },
        }),
      }),
    );
  });

  it("debounces rapid duplicate pushes for the same image", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      text: async () => "",
    });

    const app = createApp(baseConfig, mockFetch as unknown as typeof fetch);

    const createPayload = (tag: string) =>
      JSON.stringify({
        action: "published",
        package: {
          name: "kgtkr.net",
          package_type: "container",
          owner: { login: "kgtkr" },
          package_version: {
            container_metadata: {
              tag: { name: tag },
            },
          },
        },
      });

    // First tag: dispatches
    const body1 = createPayload("latest");
    const res1 = await app.request("/webhook", {
      method: "POST",
      headers: {
        "x-hub-signature-256": sign(body1, secret),
        "x-github-event": "package",
      },
      body: body1,
    });
    expect(res1.status).toBe(200);
    const data1 = await res1.json();
    expect(data1.dispatched).toBe(true);

    // Second tag within debounce window: debounced!
    const body2 = createPayload("20261017-8d3e086");
    const res2 = await app.request("/webhook", {
      method: "POST",
      headers: {
        "x-hub-signature-256": sign(body2, secret),
        "x-github-event": "package",
      },
      body: body2,
    });
    expect(res2.status).toBe(200);
    const data2 = await res2.json();
    expect(data2.dispatched).toBe(false);
    expect(data2.message).toContain("Debounced duplicate dispatch");

    // Only 1 fetch call should have occurred
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
