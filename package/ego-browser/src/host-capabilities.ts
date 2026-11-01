/**
 * Feature detection for host extensions to `globalThis.ego`.
 *
 * The Linux host adds bindings the macOS and Windows app do not have (yet):
 * task-space TTL, memo, tab restore, hand-off relay, and the round log. It
 * lists them in `ego.getHostCapabilities()`. The app has no such function, so
 * every extension is off there and the SDK keeps its old behavior.
 */
import { withHint } from "./ego-errors.js";

export type HostCapabilities = {
  host?: string;
  taskSpaceTtl?: boolean;
  taskSpaceMemo?: boolean;
  restoreTaskSpaceTabs?: boolean;
  handOffRelay?: boolean;
  handOffViewer?: boolean;
  logEvent?: boolean;
};

const cache = new WeakMap<object, HostCapabilities>();

/** The host's capabilities, or {} when it reports none. Never throws. */
export function hostCapabilities(
  ego: any = (globalThis as any).ego,
): HostCapabilities {
  if (!ego || typeof ego !== "object") return {};
  const known = cache.get(ego);
  if (known) return known;
  let result: HostCapabilities = {};
  try {
    const value =
      typeof ego.getHostCapabilities === "function"
        ? ego.getHostCapabilities()
        : undefined;
    // A Promise here would be a future binding shape; treat it as unknown.
    if (
      value &&
      typeof value === "object" &&
      typeof value.then !== "function"
    ) {
      result = { ...value };
    }
  } catch {
    result = {};
  }
  cache.set(ego, result);
  return result;
}

/** True when the host offers this extension and the binding exists. */
export function hostSupports(
  capability: keyof HostCapabilities,
  binding: string,
  ego: any = (globalThis as any).ego,
): boolean {
  return (
    hostCapabilities(ego)[capability] === true &&
    typeof ego?.[binding] === "function"
  );
}

/** The error for a host extension this host does not have. */
export function unsupportedOnHost(api: string, detail = "") {
  return withHint(
    "EGO_UNSUPPORTED_ON_HOST",
    `${api} is not supported on this browser host${detail ? `: ${detail}` : ""}`,
    "This feature needs the Linux host (ego-browser on Linux). On this host, continue without it.",
  );
}
