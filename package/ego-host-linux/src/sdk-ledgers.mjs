/**
 * The SDK keeps the Page labels and refs of each task space in a ledger file,
 * `space-<id>.json`, in EGO_BROWSER_STATE_DIR or ~/.ego-browser/state (see
 * package/ego-browser/src/page-ledger.ts). The SDK deletes a ledger on
 * `finish()`. A space that the daemon closes (gc, `ego-browser close`, an
 * ephemeral space's end) never reaches the SDK again, so its ledger stays;
 * the SDK's own cleanup only removes ledgers after 30 days. The daemon removes
 * the ledgers of the spaces it no longer has.
 */
import { readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LEDGER = /^space-(\d+)\.json$/;

export function sdkStateDir(env = process.env) {
  return env.EGO_BROWSER_STATE_DIR || join(homedir(), ".ego-browser", "state");
}

/**
 * Remove the ledger of each space id below `nextId` that is not in `liveIds`.
 * An id at or above `nextId` is not issued yet, so its ledger is left alone.
 * @param {{ dir: string, liveIds: Iterable<number>, nextId: number, dryRun?: boolean }} options
 * @returns {number[]} the space ids whose ledger was (or would be) removed
 */
export function pruneSdkLedgers({ dir, liveIds, nextId, dryRun = false }) {
  const live = new Set(liveIds);
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const removed = [];
  for (const name of names) {
    const match = LEDGER.exec(name);
    if (!match) continue;
    const id = Number(match[1]);
    if (live.has(id) || id >= nextId) continue;
    if (!dryRun) rmSync(join(dir, name), { force: true });
    removed.push(id);
  }
  return removed.sort((a, b) => a - b);
}
