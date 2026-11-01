/**
 * An in-process SDK session for the host's own commands (one-shot commands
 * and the MCP server): the daemon connection, the `globalThis.ego` bindings
 * and the imported SDK, plus `round(fn)`, which runs `fn` as one SDK round.
 *
 * A round goes through the SDK's `runMain()`, the same path as
 * `ego-browser nodejs`, so lint, the output sink and error hints behave the
 * same. The built-in script only calls back into `fn`; arguments and results
 * never pass through script text.
 */
import { pathToFileURL } from "node:url";

import { createEgoBindings } from "./ego-bindings.mjs";

const ROUND_SCRIPT =
  "globalThis.__egoHostRoundResult = await globalThis.__egoHostRound(globalThis);";

/**
 * Open a session.
 *
 * @param {object} options
 * @param {string} options.sdkPath     absolute path of the SDK's index.js
 * @param {() => Promise<{control, hello}>} options.connect
 *        connect to (or start) the daemon and say hello
 * @param {(sdkPath: string) => Promise<object>} [options.importSdk]
 * @param {typeof createEgoBindings} [options.createBindings]
 */
export async function openSdkSession({
  sdkPath,
  connect,
  importSdk = (path) => import(pathToFileURL(path).href),
  createBindings = createEgoBindings,
}) {
  const { control, hello } = await connect();
  let ego;
  let module;
  try {
    ego = await createBindings({ control, hello });
    globalThis.ego = ego;
    // The SDK keys Page labels by browser run (see runNodejs in the CLI).
    process.env.EGO_BROWSER_INSTANCE_ID = hello.instanceId;
    // Importing the SDK installs it on globalThis (installEgoSdk).
    module = await importSdk(sdkPath);
  } catch (error) {
    ego?.close?.();
    control.close();
    throw error;
  }

  let closed = false;

  /** One runMain() round; its output is collected, never printed. */
  async function runRound(source) {
    const chunks = [];
    const sink = { write: (chunk) => chunks.push(String(chunk)) };
    const started = Date.now();
    ego.logRound?.("start");
    let exit = 1;
    try {
      const code = await module.runMain({
        argv: [],
        stdinText: source,
        stdout: sink,
        stderr: sink,
      });
      if (code !== 0) {
        throw Object.assign(
          new Error(chunks.join("").trim() || "the script is empty"),
          { error_code: "EGO_INVALID_ARGUMENT" },
        );
      }
      exit = 0;
      return chunks.join("");
    } catch (error) {
      if (error && typeof error === "object") {
        try {
          error.output = chunks.join("");
        } catch {
          // A frozen error keeps no output.
        }
      }
      throw error;
    } finally {
      ego.logRound?.("end", { exit, ms: Date.now() - started });
    }
  }

  return {
    control,
    hello,
    ego,
    module,
    /**
     * Run `fn(globalThis)` as one SDK round and return `{ value, output }`.
     * Whatever the round prints (console.log, page notices) is in `output`;
     * it never reaches this process's stdout.
     */
    async round(fn) {
      globalThis.__egoHostRound = fn;
      globalThis.__egoHostRoundResult = undefined;
      try {
        const output = await runRound(ROUND_SCRIPT);
        return { value: globalThis.__egoHostRoundResult, output };
      } finally {
        globalThis.__egoHostRound = undefined;
        globalThis.__egoHostRoundResult = undefined;
      }
    },
    /** Run an agent's script text as one round; returns what it printed. */
    runScript(source) {
      return runRound(source);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (typeof module?.disposeEgoSdk === "function") {
        await module.disposeEgoSdk(globalThis).catch(() => {});
      }
      await Promise.resolve(ego.flushLog?.()).catch(() => {});
      ego.close?.();
      control.close();
    },
  };
}

/** The `error_code`, `status` and `hint` an SDK error carries, if any. */
export function errorDetails(error) {
  const code = error?.error_code || error?.code;
  return {
    message: String(error?.message || error || "unknown error"),
    ...(typeof code === "string" ? { error_code: code } : {}),
    ...(typeof error?.status === "number" ? { status: error.status } : {}),
    ...(typeof error?.hint === "string" && error.hint
      ? { hint: error.hint }
      : {}),
  };
}
