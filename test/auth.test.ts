import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import crypto from "node:crypto";
import {
  generateAppJwt,
  getInstallationToken,
  getInstallationTokenForRepo,
  resolveAuthToken,
  clearTokenCache,
} from "../src/auth.ts";
import { parsePrivateKey, envParser, type AppConfig } from "../src/config.ts";

describe("auth", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  beforeEach(() => {
    clearTokenCache();
    vi.restoreAllMocks();
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

  describe("generateAppJwt", () => {
    it("generates a valid RS256 JWT verifiable with public key", () => {
      const jwt = generateAppJwt("app-12345", privateKey);
      const parts = jwt.split(".");
      expect(parts).toHaveLength(3);

      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());

      expect(header).toEqual({ alg: "RS256", typ: "JWT" });
      expect(payload.iss).toBe("app-12345");
      expect(payload.exp - payload.iat).toBe(660);

      const verifier = crypto.createVerify("RSA-SHA256");
      verifier.update(`${parts[0]}.${parts[1]}`);
      const valid = verifier.verify(publicKey, parts[2], "base64url");
      expect(valid).toBe(true);
    });
  });

  describe("getInstallationToken", () => {
    it("fetches and caches installation token", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          token: "ghs_test_installation_token",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
      });

      const token1 = await getInstallationToken(
        "app-123",
        privateKey,
        42,
        mockFetch as unknown as typeof fetch,
      );
      expect(token1).toBe("ghs_test_installation_token");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Cached call
      const token2 = await getInstallationToken(
        "app-123",
        privateKey,
        42,
        mockFetch as unknown as typeof fetch,
      );
      expect(token2).toBe("ghs_test_installation_token");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("getInstallationTokenForRepo", () => {
    it("looks up installation ID for repo, caches installation ID, and respects token expiry", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 999 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({
            token: "ghs_short_lived_token",
            // Expires in 30s (within the 60s refresh buffer, so next call must refresh token)
            expires_at: new Date(Date.now() + 30_000).toISOString(),
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({
            token: "ghs_refreshed_token",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          }),
        });

      const token1 = await getInstallationTokenForRepo(
        "app-123",
        privateKey,
        "kgtkr/public-cd",
        mockFetch as unknown as typeof fetch,
      );

      expect(token1).toBe("ghs_short_lived_token");
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "https://api.github.com/repos/kgtkr/public-cd/installation",
        expect.any(Object),
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "https://api.github.com/app/installations/999/access_tokens",
        expect.any(Object),
      );

      // Second call: installation ID is cached, but short-lived token is refreshed
      const token2 = await getInstallationTokenForRepo(
        "app-123",
        privateKey,
        "kgtkr/public-cd",
        mockFetch as unknown as typeof fetch,
      );
      expect(token2).toBe("ghs_refreshed_token");
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch).toHaveBeenNthCalledWith(
        3,
        "https://api.github.com/app/installations/999/access_tokens",
        expect.any(Object),
      );
    });
  });

  describe("resolveAuthToken", () => {
    it("uses GITHUB_TOKEN when present", async () => {
      const config: AppConfig = {
        PORT: 3000,
        WEBHOOK_SECRET: "sec",
        TARGET_REPOS: ["kgtkr/public-cd"],
        DISPATCH_EVENT_TYPE: "ghcr_package_published",
        GITHUB_TOKEN: "pat-token",
        TAG_EXCLUDE_REGEX: /$/,
        DEBOUNCE_MS: 5000,
      };

      const token = await resolveAuthToken(config, "kgtkr/public-cd");
      expect(token).toBe("pat-token");
    });
  });

  describe("config masking", () => {
    it("marks GITHUB_APP_PRIVATE_KEY as secret in evp parser", () => {
      const v = envParser.fields.GITHUB_APP_PRIVATE_KEY as { isSecret?: boolean };
      expect(v.isSecret).toBe(true);
    });
  });
});
