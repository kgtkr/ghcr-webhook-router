import { describe, it, expect, vi } from "vite-plus/test";
import crypto from "node:crypto";
import { sign } from "@octokit/webhooks-methods";
import { verifyWebhookSignature, createGitHubClient } from "../src/auth.ts";
import { parsePrivateKey, envParser, type AppConfig } from "../src/config.ts";

describe("auth", () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  describe("parsePrivateKey", () => {
    it("preserves valid PEM", () => {
      expect(parsePrivateKey(privateKey)).toBe(privateKey.trim());
    });

    it("converts escaped newlines", () => {
      const escaped = privateKey.replace(/\n/g, "\\n");
      expect(parsePrivateKey(escaped)).toBe(privateKey);
    });

    it("decodes base64 encoded PEM", () => {
      const base64 = Buffer.from(privateKey).toString("base64");
      expect(parsePrivateKey(base64)).toBe(privateKey);
    });
  });

  describe("verifyWebhookSignature", () => {
    const secret = "test-secret-456";

    it("verifies valid signature correctly", async () => {
      const payload = JSON.stringify({ hello: "world" });
      const signature = await sign(secret, payload);

      const isValid = await verifyWebhookSignature(payload, signature, secret);
      expect(isValid).toBe(true);
    });

    it("rejects invalid signature", async () => {
      const payload = JSON.stringify({ hello: "world" });
      const isValid = await verifyWebhookSignature(payload, "sha256=invalid-signature", secret);
      expect(isValid).toBe(false);
    });

    it("rejects missing signature", async () => {
      const payload = JSON.stringify({ hello: "world" });
      const isValid = await verifyWebhookSignature(payload, undefined, secret);
      expect(isValid).toBe(false);
    });
  });

  describe("createGitHubClient with GITHUB_TOKEN", () => {
    it("dispatches event using Octokit with PAT", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

      const config: AppConfig = {
        PORT: 3000,
        WEBHOOK_SECRET: "sec",
        TARGET_REPOS: ["kgtkr/public-cd"],
        DISPATCH_EVENT_TYPE: "ghcr_package_published",
        GITHUB_TOKEN: "pat-token-xyz",
        TAG_EXCLUDE_REGEX: /$/,
        DEBOUNCE_MS: 5000,
      };

      const client = createGitHubClient(config, mockFetch as unknown as typeof fetch);
      const res = await client.dispatch("kgtkr/public-cd", "ghcr_package_published", {
        foo: "bar",
      });

      expect(res.ok).toBe(true);
      expect(res.status).toBe(204);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.github.com/repos/kgtkr/public-cd/dispatches",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            authorization: "token pat-token-xyz",
          }),
        }),
      );
    });
  });

  describe("createGitHubClient with GitHub App", () => {
    it("resolves repo installation ID and dispatches via installation token", async () => {
      const mockFetch = vi
        .fn()
        // 1. App JWT request to get repo installation
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 888 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
        // 2. Installation token creation request
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              token: "ghs_app_installation_token",
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
            }),
            {
              status: 201,
              headers: { "content-type": "application/json" },
            },
          ),
        )
        // 3. Dispatch event request
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      const config: AppConfig = {
        PORT: 3000,
        WEBHOOK_SECRET: "sec",
        TARGET_REPOS: ["kgtkr/public-cd"],
        DISPATCH_EVENT_TYPE: "ghcr_package_published",
        GITHUB_APP_ID: "app-1234",
        GITHUB_APP_PRIVATE_KEY: privateKey,
        TAG_EXCLUDE_REGEX: /$/,
        DEBOUNCE_MS: 5000,
      };

      const client = createGitHubClient(config, mockFetch as unknown as typeof fetch);
      const res = await client.dispatch("kgtkr/public-cd", "ghcr_package_published", {
        foo: "bar",
      });

      expect(res.ok).toBe(true);
      expect(res.status).toBe(204);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "https://api.github.com/repos/kgtkr/public-cd/installation",
        expect.any(Object),
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "https://api.github.com/app/installations/888/access_tokens",
        expect.any(Object),
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        3,
        "https://api.github.com/repos/kgtkr/public-cd/dispatches",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            authorization: "token ghs_app_installation_token",
          }),
        }),
      );
    });
  });

  describe("config masking", () => {
    it("marks GITHUB_APP_PRIVATE_KEY as secret in evp parser", () => {
      const v = envParser.fields.GITHUB_APP_PRIVATE_KEY as { isSecret?: boolean };
      expect(v.isSecret).toBe(true);
    });
  });
});
