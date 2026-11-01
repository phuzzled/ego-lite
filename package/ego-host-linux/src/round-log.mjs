/**
 * Round logs: one JSON line per action, per task space, in
 * ~/.local/state/ego-lite/rounds/<spaceId>.jsonl, and daemon events in
 * ~/.local/state/ego-lite/events.jsonl.
 *
 * Entries hold names, ids, timings and error codes only. Never page content,
 * typed text, URLs with their query, or tokens: `sanitizeEntry` keeps a fixed
 * set of short fields and drops the rest.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { stateDir } from "./paths.mjs";

export function roundsDir(env = process.env) {
  return join(stateDir(env), "rounds");
}

export function eventsFile(env = process.env) {
  return join(stateDir(env), "events.jsonl");
}

const STRING_FIELDS = {
  round: 40,
  page: 64,
  action: 64,
  target: 80,
  error_code: 64,
  kind: 16,
  event: 32,
  message: 200,
};
const NUMBER_FIELDS = ["ts", "space", "ms", "exit", "count"];

/** Keep only known, short fields. */
export function sanitizeEntry(entry) {
  const clean = {};
  if (!entry || typeof entry !== "object") return clean;
  for (const key of NUMBER_FIELDS) {
    if (Number.isFinite(entry[key])) clean[key] = Math.round(entry[key]);
  }
  for (const [key, max] of Object.entries(STRING_FIELDS)) {
    if (typeof entry[key] === "string" && entry[key].length > 0) {
      clean[key] = entry[key].replace(/[\u0000-\u001f]/g, " ").slice(0, max);
    }
  }
  if (typeof entry.ok === "boolean") clean.ok = entry.ok;
  return clean;
}

/** Scheme, host and path of a URL; no query, fragment or credentials. */
export function redactUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$|^file:$/.test(parsed.protocol)) return parsed.protocol;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "";
  }
}

export class RoundLog {
  #dir;
  #events;
  #maxBytes;
  #now;

  constructor({
    env = process.env,
    maxBytes = 1024 * 1024,
    now = Date.now,
  } = {}) {
    this.#dir = roundsDir(env);
    this.#events = eventsFile(env);
    this.#maxBytes = maxBytes;
    this.#now = now;
  }

  /** Append round entries; each goes to the file of its task space. */
  append(entries) {
    for (const raw of entries) {
      const entry = sanitizeEntry({ ts: this.#now(), ...raw });
      const name = Number.isInteger(entry.space) ? String(entry.space) : "none";
      this.#write(join(this.#dir, `${name}.jsonl`), entry);
    }
  }

  /** A daemon event: start, stop, gc, limits, hand-off, viewer. */
  event(event, fields = {}) {
    this.#write(
      this.#events,
      sanitizeEntry({ ts: this.#now(), kind: "daemon", event, ...fields }),
    );
  }

  #write(file, entry) {
    try {
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      if (existsSync(file) && statSync(file).size > this.#maxBytes) {
        renameSync(file, `${file}.1`);
      }
      appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // Logging must never break a round.
    }
  }
}

function readLines(file) {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The last `limit` entries, oldest first: one space, or the daemon events and
 * all spaces.
 */
export function readLogs({ env = process.env, space, limit = 50 } = {}) {
  const dir = roundsDir(env);
  const files = [];
  if (space !== undefined) {
    files.push(join(dir, `${space}.jsonl.1`), join(dir, `${space}.jsonl`));
  } else {
    files.push(`${eventsFile(env)}.1`, eventsFile(env));
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (/\.jsonl(\.1)?$/.test(name)) files.push(join(dir, name));
    }
  }
  const entries = files.flatMap(readLines);
  entries.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return limit > 0 ? entries.slice(-limit) : entries;
}

/** One line for a human. */
export function formatEntry(entry) {
  const time = new Date(entry.ts ?? 0).toISOString();
  const parts = [time];
  if (entry.kind === "daemon") {
    parts.push("daemon", entry.event ?? "");
    if (entry.space !== undefined) parts.push(`space ${entry.space}`);
    if (entry.message) parts.push(entry.message);
    return parts.join("  ");
  }
  if (entry.round) parts.push(`round ${entry.round}`);
  if (entry.space !== undefined) parts.push(`space ${entry.space}`);
  if (entry.kind === "round") {
    parts.push(
      entry.event === "end"
        ? `round end exit=${entry.exit} ${entry.ms ?? "?"}ms${entry.count !== undefined ? ` actions=${entry.count}` : ""}`
        : "round start",
    );
    return parts.join("  ");
  }
  if (entry.page) parts.push(entry.page);
  parts.push(entry.action ?? "?");
  if (entry.target) parts.push(entry.target);
  parts.push(
    entry.ok === false ? `FAILED ${entry.error_code ?? ""}`.trim() : "ok",
  );
  if (entry.ms !== undefined) parts.push(`${entry.ms}ms`);
  return parts.join("  ");
}
