import { verify } from "@octokit/webhooks-methods";
import { Octokit, App } from "octokit";
import type { AppConfig } from "./config.ts";

export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) {
    return false;
  }
  try {
    return await verify(secret, rawBody, signatureHeader);
  } catch {
    return false;
  }
}

export interface DispatchTargetResult {
  repo: string;
  ok: boolean;
  status: number;
  error?: string;
}

export interface GitHubClient {
  dispatch(
    targetRepo: string,
    eventType: string,
    clientPayload: Record<string, unknown>,
  ): Promise<DispatchTargetResult>;
}

export function createGitHubClient(config: AppConfig, fetchFn?: typeof fetch): GitHubClient {
  const customOctokit = fetchFn ? Octokit.defaults({ request: { fetch: fetchFn } }) : Octokit;

  if (config.GITHUB_TOKEN) {
    const octokit = new customOctokit({ auth: config.GITHUB_TOKEN });
    return {
      async dispatch(targetRepo, eventType, clientPayload) {
        const [owner, repo] = targetRepo.split("/");
        try {
          const res = await octokit.rest.repos.createDispatchEvent({
            owner,
            repo,
            event_type: eventType,
            client_payload: clientPayload,
          });
          return { repo: targetRepo, ok: true, status: res.status };
        } catch (err: unknown) {
          const status =
            err && typeof err === "object" && "status" in err
              ? Number((err as { status: unknown }).status)
              : 500;
          const message = err instanceof Error ? err.message : String(err);
          return { repo: targetRepo, ok: false, status, error: message };
        }
      },
    };
  }

  if (config.GITHUB_APP_ID && config.GITHUB_APP_PRIVATE_KEY) {
    const app = new App({
      appId: config.GITHUB_APP_ID,
      privateKey: config.GITHUB_APP_PRIVATE_KEY,
      Octokit: customOctokit,
    });

    const repoInstallationCache = new Map<string, number>();

    return {
      async dispatch(targetRepo, eventType, clientPayload) {
        const [owner, repo] = targetRepo.split("/");
        try {
          let installationId = repoInstallationCache.get(targetRepo);
          if (installationId === undefined) {
            const { data } = await app.octokit.rest.apps.getRepoInstallation({
              owner,
              repo,
            });
            installationId = data.id;
            repoInstallationCache.set(targetRepo, installationId);
          }

          let octokit: Octokit;
          try {
            octokit = (await app.getInstallationOctokit(installationId)) as Octokit;
          } catch (err) {
            repoInstallationCache.delete(targetRepo);
            throw err;
          }

          const res = await octokit.rest.repos.createDispatchEvent({
            owner,
            repo,
            event_type: eventType,
            client_payload: clientPayload,
          });
          return { repo: targetRepo, ok: true, status: res.status };
        } catch (err: unknown) {
          const status =
            err && typeof err === "object" && "status" in err
              ? Number((err as { status: unknown }).status)
              : 500;
          const message = err instanceof Error ? err.message : String(err);
          return { repo: targetRepo, ok: false, status, error: message };
        }
      },
    };
  }

  throw new Error("No authentication method configured");
}
