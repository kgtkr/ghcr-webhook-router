import * as EVP from "evp-ts";

export interface AppConfig {
  PORT: number;
  WEBHOOK_SECRET: string;
  TARGET_REPOS: string[];
  DISPATCH_EVENT_TYPE: string;
  GITHUB_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  TAG_INCLUDE_REGEX?: RegExp;
  TAG_EXCLUDE_REGEX: RegExp;
  PACKAGE_INCLUDE_REGEX?: RegExp;
  DEBOUNCE_MS: number;
}

export function parsePrivateKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (!trimmed.includes("-----BEGIN") && !trimmed.includes("PRIVATE KEY")) {
    try {
      const decoded = Buffer.from(trimmed, "base64").toString("utf-8");
      if (decoded.includes("PRIVATE KEY")) {
        return decoded;
      }
    } catch {
      // Not base64 encoded
    }
  }
  return trimmed.replace(/\\n/g, "\n");
}

export const envParser = EVP.object({
  PORT: EVP.number().default(3000).description("Server listening port"),
  WEBHOOK_SECRET: EVP.string().secret().description("GitHub webhook secret"),
  TARGET_REPOS: EVP.string()
    .map((s) =>
      s
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
    )
    .description("Target repositories (comma-separated, e.g. kgtkr/public-cd)"),
  DISPATCH_EVENT_TYPE: EVP.string()
    .default("ghcr_package_published")
    .description("repository_dispatch event_type"),
  GITHUB_TOKEN: EVP.string().secret().optional().description("GitHub personal access token"),
  GITHUB_APP_ID: EVP.string().optional().description("GitHub App ID"),
  GITHUB_APP_PRIVATE_KEY: EVP.string()
    .map((k) => (k ? parsePrivateKey(k) : undefined))
    .secret()
    .optional()
    .description("GitHub App private key (PEM or base64)"),
  TAG_INCLUDE_REGEX: EVP.string()
    .map((r) => (r ? new RegExp(r) : undefined))
    .optional()
    .description("Regex pattern for tags to include"),
  TAG_EXCLUDE_REGEX: EVP.string()
    .map((r) => new RegExp(r))
    .default(/-(amd64|arm64)$/)
    .description("Regex pattern for tags to exclude"),
  PACKAGE_INCLUDE_REGEX: EVP.string()
    .map((r) => (r ? new RegExp(r) : undefined))
    .optional()
    .description("Regex pattern for packages to include"),
  DEBOUNCE_MS: EVP.number().default(5000).description("Debounce window in milliseconds"),
});

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envParser.parse(env as Record<string, string>);

  if (parsed.TARGET_REPOS.length === 0) {
    throw new Error("TARGET_REPOS must contain at least one repository");
  }

  if (!parsed.GITHUB_TOKEN && (!parsed.GITHUB_APP_ID || !parsed.GITHUB_APP_PRIVATE_KEY)) {
    throw new Error(
      "Either GITHUB_TOKEN or (GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY) must be provided",
    );
  }

  return parsed as AppConfig;
}
