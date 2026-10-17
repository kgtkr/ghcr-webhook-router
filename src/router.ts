import type { components } from "@octokit/openapi-webhooks-types";
import type { AppConfig } from "./config.ts";
import { createGitHubClient, type GitHubClient, type DispatchTargetResult } from "./auth.ts";

export type PackagePublishedPayload = components["schemas"]["webhook-package-published"];
export type RegistryPackagePublishedPayload =
  components["schemas"]["webhook-registry-package-published"];

export type WebhookPayload = {
  action?: string;
  package?: PackagePublishedPayload["package"];
  registry_package?: RegistryPackagePublishedPayload["registry_package"];
  installation?: { id: number };
  [key: string]: unknown;
};

export type PackageWebhookPayload = WebhookPayload;

export interface RouterResult {
  dispatched: boolean;
  message: string;
  image?: string;
  tag?: string;
  targets?: DispatchTargetResult[];
}

const lastDispatched = new Map<string, number>();
const inFlightDispatches = new Set<string>();

export function clearDebounceCache(): void {
  lastDispatched.clear();
  inFlightDispatches.clear();
}

function pruneDebounceCache(now: number, maxAgeMs: number): void {
  if (lastDispatched.size > 500) {
    for (const [key, timestamp] of lastDispatched.entries()) {
      if (now - timestamp > maxAgeMs) {
        lastDispatched.delete(key);
      }
    }
  }
}

export async function processWebhook(
  eventHeader: string | undefined,
  payload: WebhookPayload,
  config: AppConfig,
  clientOrFetch?: GitHubClient | typeof fetch,
): Promise<RouterResult> {
  if (eventHeader === "ping") {
    return { dispatched: false, message: "Pong" };
  }

  if (eventHeader !== "package" && eventHeader !== "registry_package") {
    return { dispatched: false, message: `Ignored event: ${eventHeader}` };
  }

  if (payload.action !== "published") {
    return { dispatched: false, message: `Ignored action: ${payload.action}` };
  }

  const pkg = payload.package ?? payload.registry_package;
  if (!pkg) {
    return { dispatched: false, message: "Missing package payload" };
  }

  if (pkg.package_type !== "container") {
    return {
      dispatched: false,
      message: `Ignored package_type: ${pkg.package_type}`,
    };
  }

  const tag = pkg.package_version?.container_metadata?.tag?.name;
  if (!tag) {
    return { dispatched: false, message: "Untagged manifest, ignored" };
  }

  const pkgOwner = pkg.owner?.login;
  const pkgName = pkg.name;
  if (!pkgOwner || !pkgName) {
    return { dispatched: false, message: "Missing package owner or name" };
  }

  const image = `ghcr.io/${pkgOwner}/${pkgName}`;

  if (config.PACKAGE_INCLUDE_REGEX && !config.PACKAGE_INCLUDE_REGEX.test(image)) {
    return {
      dispatched: false,
      message: `Image ${image} did not match PACKAGE_INCLUDE_REGEX`,
      image,
      tag,
    };
  }

  if (config.TAG_EXCLUDE_REGEX && config.TAG_EXCLUDE_REGEX.test(tag)) {
    return {
      dispatched: false,
      message: `Tag ${tag} matched TAG_EXCLUDE_REGEX, ignored`,
      image,
      tag,
    };
  }

  if (config.TAG_INCLUDE_REGEX && !config.TAG_INCLUDE_REGEX.test(tag)) {
    return {
      dispatched: false,
      message: `Tag ${tag} did not match TAG_INCLUDE_REGEX, ignored`,
      image,
      tag,
    };
  }

  const now = Date.now();
  pruneDebounceCache(now, Math.max(config.DEBOUNCE_MS * 10, 60_000));

  const debounceKey = image;
  const lastTime = lastDispatched.get(debounceKey);
  if (
    inFlightDispatches.has(debounceKey) ||
    (lastTime !== undefined && now - lastTime < config.DEBOUNCE_MS)
  ) {
    return {
      dispatched: false,
      message: `Debounced duplicate dispatch for ${image} (within ${config.DEBOUNCE_MS}ms)`,
      image,
      tag,
    };
  }

  inFlightDispatches.add(debounceKey);

  const clientPayload = {
    registry: "ghcr.io",
    owner: pkgOwner,
    package: pkgName,
    image,
    tag,
    digest: pkg.package_version?.container_metadata?.tag?.digest || pkg.package_version?.version,
  };

  const client: GitHubClient =
    clientOrFetch && typeof clientOrFetch === "object" && "dispatch" in clientOrFetch
      ? clientOrFetch
      : createGitHubClient(config, typeof clientOrFetch === "function" ? clientOrFetch : undefined);

  try {
    const targets = await Promise.all(
      config.TARGET_REPOS.map(async (targetRepo) => {
        return await client.dispatch(targetRepo, config.DISPATCH_EVENT_TYPE, clientPayload);
      }),
    );

    const anyFailed = targets.some((t) => !t.ok);
    if (!anyFailed) {
      lastDispatched.set(debounceKey, Date.now());
    }

    return {
      dispatched: !anyFailed,
      message: anyFailed ? "Some dispatches failed" : "Dispatched successfully",
      image,
      tag,
      targets,
    };
  } finally {
    inFlightDispatches.delete(debounceKey);
  }
}
