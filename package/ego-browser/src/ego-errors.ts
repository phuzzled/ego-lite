/**
 * Shared handling for ego-binding errors.
 *
 * Browser-side failures expose two signals (see the EgoBindings JS API):
 *   - human-readable text (`error` on resolved results, `message` on rejected
 *     Errors), and
 *   - a stable `error_code` such as EGO_TASK_SPACE_USER_IN_CONTROL.
 *
 * The code is the durable contract; the wording can drift between builds. Branch
 * on the code (isEgoUserControlError), not on the message. EGO_ERROR_MESSAGES is
 * where ego-browser owns its wording for the few codes an agent must act on; every
 * other code (and any unknown future code) defers to the native error message.
 *
 * Single source of truth — error handling was previously duplicated across
 * helpers.ts and driver/nav.ts.
 */

import { markHardStop } from "./output-sink.js";

/** Stable error codes emitted by the native ego bindings. */
export const EGO_ERROR_CODES = [
  "EGO_BROWSER_UNAVAILABLE",
  "EGO_CDP_CHANNEL_UNAVAILABLE",
  "EGO_CDP_SEND_FAILED",
  "EGO_INVALID_ARGUMENT",
  "EGO_INVALID_RESULT_PAYLOAD",
  "EGO_OPERATION_FAILED",
  "EGO_RESOURCE_LIMIT",
  "EGO_RESULT_CONVERSION_FAILED",
  "EGO_SNAPSHOT_FAILED",
  "EGO_TASK_HOST_DISCONNECTED",
  "EGO_TASK_SPACE_INACTIVE",
  "EGO_TASK_SPACE_NAME_IN_USE",
  "EGO_TASK_SPACE_NOT_FOUND",
  "EGO_TASK_SPACE_NOT_SELECTED",
  "EGO_TASK_SPACE_UNAVAILABLE",
  "EGO_TASK_SPACE_USER_IN_CONTROL",
  "EGO_WEB_CONTENTS_UNAVAILABLE",
] as const;

export type EgoErrorCode = (typeof EGO_ERROR_CODES)[number];

/**
 * Codes whose wording ego-browser owns. A listed code returns this static, id-less
 * message instead of the native error message — reserved for the two business signals
 * an agent must react to, not just report. Every other code is absent here and defers
 * to the native error message (and any unknown future code does too), which is more
 * specific than any static line.
 */
const EGO_ERROR_MESSAGES: Partial<Record<EgoErrorCode, string>> = {
  // The native code does not say who ended the task or moved control: the
  // agent's own task.finish() / task.handOff() produce the same codes as user
  // actions in the browser. Keep this wording neutral about the cause.
  EGO_TASK_SPACE_INACTIVE: [
    "This task space is no longer assigned to the agent: its task has ended, either through task.finish() or by the user, so browser commands are paused.",
    "This is a hard stop, not an obstacle to route around — do not retry and do not take ownership back on your own. takeOverTaskSpace() cannot resume an ended task.",
    "Wait until the user explicitly asks you to continue in this space, then claim it and resume:",
    "  const task = await claimTaskSpace(spaceId)",
    "",
    `Offer the user choices like "Continue" or "Done" if your harness supports it; otherwise tell them: "This task has ended and the space is yours. Reply 'continue' if you want me to resume in it."`,
  ].join("\n"),
  EGO_TASK_SPACE_USER_IN_CONTROL: [
    "Control of this task space is with the user, either through task.handOff() or a takeover in the browser, so browser commands are paused.",
    "This is a hard stop, not an obstacle to route around — do not retry and do not take control back on your own.",
    "Wait until the user explicitly asks you to continue, then take control back and resume:",
    "  const task = await takeOverTaskSpace(spaceId)",
    "",
    `Offer the user choices like "Continue" or "Finish task" if your harness supports it; otherwise tell them: "You now control this task space. Reply 'continue' when ready and I will resume."`,
  ].join("\n"),
};

const USER_CONTROL_GUIDANCE =
  EGO_ERROR_MESSAGES.EGO_TASK_SPACE_USER_IN_CONTROL as string;

const USER_CONTROL_REASON_MESSAGES = Object.freeze({
  notifications: permissionPrompt("notifications"),
  location: permissionPrompt("location access"),
  camera: permissionPrompt("camera access"),
  microphone: permissionPrompt("microphone access"),
  pan_tilt_zoom_microphone: permissionPrompt(
    "camera control and microphone access",
  ),
  midi: permissionPrompt("MIDI device access"),
  bluetooth: userPromptGuidance(
    "A browser device chooser for Bluetooth has appeared.",
  ),
  usb: userPromptGuidance("A browser device chooser for USB has appeared."),
  serial: userPromptGuidance(
    "A browser port chooser for serial access has appeared.",
  ),
  hid: userPromptGuidance("A browser device chooser for HID has appeared."),
  protocol_handler: permissionPrompt("protocol handler registration"),
  manual_takeover: USER_CONTROL_GUIDANCE,
});

function permissionPrompt(access: string): string {
  return userPromptGuidance(
    `A browser permission prompt for ${access} has appeared.`,
  );
}

function userPromptGuidance(firstLine: string): string {
  return [
    firstLine,
    "The user now controls this task space. Wait for the user to handle the prompt.",
    "Resume only after the user confirms, using takeOverTaskSpace(spaceId).",
  ].join("\n");
}

/** Type guard for codes this build knows about. */
export function isEgoErrorCode(value: unknown): value is EgoErrorCode {
  return (
    typeof value === "string" &&
    (EGO_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Pull the stable error_code out of any ego error shape: resolved
 * `{ error, error_code }` objects, rejected/thrown Errors carrying `.error_code`,
 * or a bare known code string. Returns the raw code (which may be one this build
 * does not know about yet) or undefined when none is present.
 */
export function egoErrorCode(err: unknown): string | undefined {
  if (typeof err === "string") {
    return isEgoErrorCode(err) ? err : undefined;
  }
  if (err && typeof err === "object") {
    const code = (err as Record<string, unknown>).error_code;
    if (typeof code === "string" && code) return code;
  }
  return undefined;
}

/**
 * Resolve any ego error into a stable `{ code, message }` pair.
 *
 * For a code ego-browser owns wording for, `message` is that owned wording.
 * Otherwise (a code not owned here, or an unknown future code) it falls back to
 * the native error message the binding returned, then the bare code, then a
 * generic string. `code` is the stable classifier and may be undefined.
 */
export function resolveEgoError(err: unknown): {
  code?: string;
  message: string;
} {
  const code = egoErrorCode(err);
  const message =
    (code === "EGO_TASK_SPACE_USER_IN_CONTROL"
      ? resolveUserControlMessage(err)
      : isEgoErrorCode(code)
        ? EGO_ERROR_MESSAGES[code]
        : undefined) ??
    nativeErrorText(err) ??
    code ??
    "Unknown ego error";
  return { code, message };
}

function resolveUserControlMessage(err: unknown): string {
  const nativeText = nativeErrorText(err);
  if (nativeText && Object.hasOwn(USER_CONTROL_REASON_MESSAGES, nativeText)) {
    return USER_CONTROL_REASON_MESSAGES[
      nativeText as keyof typeof USER_CONTROL_REASON_MESSAGES
    ];
  }
  return USER_CONTROL_GUIDANCE;
}

/** Whether an ego error means the task is currently under user control. */
export function isEgoUserControlError(err: unknown): boolean {
  return egoErrorCode(err) === "EGO_TASK_SPACE_USER_IN_CONTROL";
}

/**
 * Probe control without turning the expected user-control response into a hard
 * stop. Ego bindings can report failures either by rejecting or by resolving an
 * `{ error, error_code }` object, so both paths must be inspected here.
 */
export async function probeAgentControl(
  invokeSnapshot: () => unknown | Promise<unknown>,
): Promise<boolean> {
  let result: unknown;
  try {
    result = await invokeSnapshot();
  } catch (error) {
    if (isEgoUserControlError(error)) return false;
    throw error;
  }
  if (isResolvedEgoError(result)) {
    if (isEgoUserControlError(result)) return false;
    throw buildEgoError(result);
  }
  return true;
}

function isResolvedEgoError(
  value: unknown,
): value is { error: unknown; error_code?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    "error" in value &&
    (value as { error?: unknown }).error != null
  );
}

/**
 * Codes that halt the whole agent task rather than mark a routable obstacle: a task
 * space the user has taken back, or one that is inactive / not assigned to this agent.
 * Both require the user to explicitly hand control back before work can resume.
 */
function isEgoHardStopCode(code: string | undefined): boolean {
  return (
    code === "EGO_TASK_SPACE_USER_IN_CONTROL" ||
    code === "EGO_TASK_SPACE_INACTIVE"
  );
}

/**
 * Build an Error carrying the resolved message and stable error_code from any ego
 * error shape. `op`, when given, prefixes the message with the failing operation.
 * Shared by invokeEgo and the CDP-send failure path so every ego failure surfaces
 * an identical Error shape.
 */
export function buildEgoError(
  err: unknown,
  op?: string,
): Error & { error_code?: string } {
  const { code, message } = resolveEgoError(err);
  if (isEgoHardStopCode(code)) {
    // buildEgoError is the single birthplace of every ego error — invokeEgo and the
    // CDP-send failure path both route through it — so recording the hard stop here
    // catches it even when the agent's own try/catch later swallows the thrown Error.
    // The op-less owned message is the one the agent should see, regardless of which
    // operation surfaced it.
    markHardStop(message);
  }
  const error: Error & { error_code?: string } = new Error(
    op ? `${op}: ${message}` : message,
  );
  if (code) error.error_code = code;
  return attachHint(error);
}

/**
 * Invoke a native binding and normalize synchronous throws, rejected Promises, and
 * resolved `{ error, error_code }` objects. Control-wait probes intentionally bypass
 * this helper because observing user control is their expected result, not a hard stop.
 */
export async function invokeEgo<T>(
  op: string,
  invoke: () => T | Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await invoke();
  } catch (error) {
    throw buildEgoError(error, op);
  }
  if (
    result &&
    typeof result === "object" &&
    "error" in result &&
    result.error != null
  ) {
    throw buildEgoError(result, op);
  }
  return result;
}

/**
 * The native error message from any ego error shape — the binding's runtime
 * `error`/`message` text (dynamic, may vary across builds). Ignores bare codes.
 */
function nativeErrorText(err: unknown): string | undefined {
  if (typeof err === "string") {
    return isEgoErrorCode(err) ? undefined : err;
  }
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (obj.error != null) return formatEgoError(obj.error);
    if (typeof obj.message === "string" && obj.message) return obj.message;
  }
  return undefined;
}

export function formatEgoError(err: unknown): string {
  if (err == null) return String(err);
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/**
 * An SDK error that tells the Agent what to do next. `error_code` is the
 * stable classifier, `hint` is one imperative sentence, and `status` carries an
 * HTTP status when the failure came from a server answer.
 */
export type HintedError = Error & {
  error_code?: string;
  code?: string;
  hint?: string;
  status?: number;
};

const HINT_MARKER = "\n  hint: ";

const BROWSER_RESTART_HINT =
  "Rerun this script once. If it fails again, restart the browser host (on Linux: ego-browser stop) and read its log.";

/** Hints keyed by stable error code. Message patterns below cover the rest. */
const HINTS_BY_CODE: Record<string, string> = {
  EGO_BROWSER_UNAVAILABLE: BROWSER_RESTART_HINT,
  EGO_TASK_HOST_DISCONNECTED: BROWSER_RESTART_HINT,
  EGO_CDP_CHANNEL_UNAVAILABLE: BROWSER_RESTART_HINT,
  EGO_TASK_SPACE_USER_IN_CONTROL:
    "Stop. Tell the user what to finish, then resume with takeOverTaskSpace(spaceId) after they confirm.",
  EGO_TASK_SPACE_INACTIVE:
    "Stop. Wait until the user asks you to continue, then resume with claimTaskSpace(spaceId).",
  EGO_TASK_SPACE_NOT_FOUND:
    "List the spaces with await listTaskSpaces(), or create one with await taskSpace(name).",
  EGO_NAVIGATION_FAILED:
    "Check the URL, the host name and the network. Do not retry more than once.",
  EGO_NAVIGATION_TIMEOUT:
    "Take a snapshot to see whether the content you need is already there; otherwise retry once with a longer timeout.",
  EGO_PAGE_BUDGET_REACHED:
    "Close Pages you no longer need with await page.close(), then open a new one.",
  EGO_RESOURCE_LIMIT:
    "The browser host is at a limit (task spaces, Pages or memory). Close Pages you no longer need with await page.close(), finish old task spaces with await task.finish(), or run `ego-browser gc` (see `ego-browser status`); then retry once.",
  EGO_UNSUPPORTED_ON_HOST:
    "This browser host does not offer that feature. Continue without it, or use the Linux host (ego-browser) where it exists.",
  EGO_SECRET_NOT_FOUND:
    "No secret with that name is stored on this host. Ask the user to add it with `ego-browser secret set <name> --origin <https://site>`; never ask for the value in chat.",
  EGO_SECRET_ORIGIN_MISMATCH:
    "The secret may only be typed on the origins it was stored for. Check await page.url(); if this is the right site, the user can add its origin with `ego-browser secret set <name> --origin <origin>`.",
  EGO_SECRET_NO_FIELD:
    "No editable field took focus. Take a snapshot and pass the input's ref or a loc=role:textbox locator as the target.",
  EGO_SECRET_STORE_UNAVAILABLE:
    "The host's secret store cannot be read. Ask the user to check `ego-browser secret list`; do not ask for the secret in chat.",
  EGO_SITE_BLOCKED:
    'The site asked for a human check. Try another source (for search, engine: "bing"), or hand the task space to the user with await task.handOff(). Do not try to bypass the check.',
};

const HINT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [
    /Stale ref|Unknown ref|unknown frame provenance/,
    "Refs last one page state. Take a new snapshot and use the new ref.",
  ],
  [
    /Page changed during snapshot/,
    "The page is still drawing. Wait for the content (page.waitForSelector or page.waitForSettled), then snapshot again.",
  ],
  [
    /matched (?:[2-9]|\d{2,}) (?:elements|frame contexts)(?!, but none)/,
    "Use a ref from a fresh snapshot, add >> nth=N, or use a more exact loc=role: name.",
  ],
  [
    /matched 0 elements|Element not found|none can receive input/,
    "Take a new snapshot; the page may have changed or not rendered yet. Then use a ref or a loc= locator from it.",
  ],
  [
    /page label not found/,
    "List the live Pages with await task.pages(). After a browser restart, Pages are gone; call await task.newPage().",
  ],
  [
    /net::ERR_(?:NAME_NOT_RESOLVED|CONNECTION_\w+|TIMED_OUT|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NETWORK_CHANGED|PROXY\w*|SSL\w*|CERT\w*)/,
    "Check the host name and the network. Do not retry more than once.",
  ],
  [
    /page\.wait\w*(?:\([^)]*\))? timed out/,
    "Print a snapshot or screenshot to see what the page shows instead.",
  ],
];

/** Derive the next-step hint for any SDK or ego error, or undefined. */
export function errorHint(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as HintedError;
  if (typeof value.hint === "string" && value.hint) return value.hint;
  const code = value.error_code || value.code;
  if (code === "EGO_NAVIGATION_HTTP_ERROR") {
    return httpErrorHint(value.status);
  }
  if (typeof code === "string" && Object.hasOwn(HINTS_BY_CODE, code)) {
    return HINTS_BY_CODE[code];
  }
  const message = typeof value.message === "string" ? value.message : "";
  for (const [pattern, hint] of HINT_PATTERNS) {
    if (pattern.test(message)) return hint;
  }
  return undefined;
}

/** The hint for a navigation the server answered with an HTTP error. */
export function httpErrorHint(status?: number): string {
  const answer =
    typeof status === "number" ? `answered ${status}` : "answered an error";
  return `The server ${answer}. Check the URL. To read the status and body without navigating, use await page.fetch(url).`;
}

/**
 * Give an error its next-step hint (the explicit one, or one derived from its
 * code and message) and add `error_code`, `status` and `hint` lines after the
 * stack, which is what the CLI and the hosts print. Idempotent and additive.
 */
export function attachHint<T>(error: T, hint?: string): T {
  if (!(error instanceof Error)) return error;
  const value = error as HintedError;
  const resolved = hint || errorHint(value);
  if (!resolved) return error;
  try {
    if (value.hint !== resolved) value.hint = resolved;
  } catch {
    // A getter-only hint already carries its own value.
  }
  try {
    const stack = typeof value.stack === "string" ? value.stack : "";
    if (!stack.includes(HINT_MARKER)) {
      const code = value.error_code || value.code;
      const lines = [
        typeof code === "string" && code ? `\n  error_code: ${code}` : "",
        typeof value.status === "number" ? `\n  status: ${value.status}` : "",
        `${HINT_MARKER}${resolved}`,
      ];
      value.stack = `${stack || `${value.name}: ${value.message}`}${lines.join("")}`;
    }
  } catch {
    // A frozen or exotic error keeps its original stack.
  }
  return error;
}

/** Build an Error with a stable code and a next-step hint. */
export function withHint(
  code: string,
  message: string,
  hint: string,
  details: Record<string, unknown> = {},
): HintedError {
  const error = new Error(message) as HintedError;
  error.error_code = code;
  Object.assign(error, details);
  return attachHint(error, hint);
}
