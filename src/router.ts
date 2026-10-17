import type { AppConfig } from "./config.ts";
import { resolveAuthToken } from "./auth.ts";

export interface PackageWebhookPayload {
  action: string;
  package?: {
    name: string;
    package_type: string;
    owner: {
      login: string;
    };
    package_version?: {
      version?: string;
      container_metadata?: {
        tag?: {
          name?: string;
          digest?: string;
        };
      };
    };
  };
  installation?: {
    id: number;
  };
}

export interface RouterResult {
  dispatched: boolean;
  message: string;
  image?: string;
  tag?: string;
  targets?: Array<{ repo: string; ok: boolean; status: number; error?: string }>;
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
  payload: PackageWebhookPayload,
  config: AppConfig,
  fetchFn: typeof fetch = fetch,
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

  if (payload.package?.package_type !== "container") {
    return {
      dispatched: false,
      message: `Ignored package_type: ${payload.package?.package_type}`,
    };
  }

  const tag = payload.package.package_version?.container_metadata?.tag?.name;
  if (!tag) {
    return { dispatched: false, message: "Untagged manifest, ignored" };
  }

  const pkgOwner = payload.package.owner?.login;
  const pkgName = payload.package.name;
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
    digest:
      payload.package.package_version?.container_metadata?.tag?.digest ||
      payload.package.package_version?.version,
  };

  try {
    const targets = await Promise.all(
      config.TARGET_REPOS.map(async (targetRepo) => {
        try {
          const token = await resolveAuthToken(config, targetRepo, fetchFn);

          const res = await fetchFn(`https://api.github.com/repos/${targetRepo}/dispatches`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "ghcr-webhook-router",
            },
            body: JSON.stringify({
              event_type: config.DISPATCH_EVENT_TYPE,
              client_payload: clientPayload,
            }),
          });

          if (!res.ok) {
            const errText = await res.text();
            return {
              repo: targetRepo,
              ok: false,
              status: res.status,
              error: errText,
            };
          }

          return { repo: targetRepo, ok: true, status: res.status };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return { repo: targetRepo, ok: false, status: 500, error: message };
        }
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
