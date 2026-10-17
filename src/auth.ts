import crypto from "node:crypto";
import type { AppConfig } from "./config.ts";

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const expectedSig = signatureHeader.slice("sha256=".length);
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(rawBody);
  const calculatedSig = hmac.digest("hex");

  const expectedBuffer = Buffer.from(expectedSig, "hex");
  const calculatedBuffer = Buffer.from(calculatedSig, "hex");

  if (expectedBuffer.length !== calculatedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, calculatedBuffer);
}

export function generateAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iat: now - 60,
      exp: now + 600,
      iss: appId,
    }),
  ).toString("base64url");

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKeyPem, "base64url");
  return `${header}.${payload}.${signature}`;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<number, TokenCache>();
const repoInstallationCache = new Map<string, number>();

export function clearTokenCache(): void {
  tokenCache.clear();
  repoInstallationCache.clear();
}

export async function getInstallationToken(
  appId: string,
  privateKeyPem: string,
  installationId: number,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const jwt = generateAppJwt(appId, privateKeyPem);
  const res = await fetchFn(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ghcr-webhook-router",
      },
    },
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `Failed to get installation token for ${installationId} (${res.status}): ${errorText}`,
    );
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  const expiresAt = new Date(data.expires_at).getTime();
  tokenCache.set(installationId, { token: data.token, expiresAt });
  return data.token;
}

export async function getInstallationTokenForRepo(
  appId: string,
  privateKeyPem: string,
  repoFullName: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  let installationId = repoInstallationCache.get(repoFullName);

  if (installationId === undefined) {
    const jwt = generateAppJwt(appId, privateKeyPem);
    const res = await fetchFn(`https://api.github.com/repos/${repoFullName}/installation`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ghcr-webhook-router",
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(
        `Failed to find installation for repo ${repoFullName} (${res.status}): ${errorText}`,
      );
    }

    const data = (await res.json()) as { id: number };
    installationId = data.id;
    repoInstallationCache.set(repoFullName, installationId);
  }

  try {
    return await getInstallationToken(appId, privateKeyPem, installationId, fetchFn);
  } catch (err) {
    repoInstallationCache.delete(repoFullName);
    throw err;
  }
}

export async function resolveAuthToken(
  config: AppConfig,
  targetRepo: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  if (config.GITHUB_TOKEN) {
    return config.GITHUB_TOKEN;
  }

  if (config.GITHUB_APP_ID && config.GITHUB_APP_PRIVATE_KEY) {
    return await getInstallationTokenForRepo(
      config.GITHUB_APP_ID,
      config.GITHUB_APP_PRIVATE_KEY,
      targetRepo,
      fetchFn,
    );
  }

  throw new Error("No authentication method configured");
}
