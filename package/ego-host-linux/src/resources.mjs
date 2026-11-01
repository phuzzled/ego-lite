/** Memory used by the browser: the sum over its process tree, from /proc. */
import { readFileSync, readdirSync } from "node:fs";

const defaultFs = {
  list: () => readdirSync("/proc"),
  read: (path) => readFileSync(path, "utf8"),
};

/** Pids of `rootPid` and all its descendants. */
export function processTree(rootPid, fs = defaultFs) {
  const children = new Map();
  for (const name of fs.list()) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try {
      stat = fs.read(`/proc/${name}/stat`);
    } catch {
      continue;
    }
    // The command name may hold spaces and parentheses; fields after it are fixed.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const parent = Number(fields[1]);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(Number(name));
  }
  const pids = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    pids.push(pid);
    queue.push(...(children.get(pid) || []));
  }
  return pids;
}

/**
 * Proportional set size (shared pages split between processes) of the tree,
 * in MB; resident set size where smaps_rollup is missing. Null without /proc.
 */
export function processTreeMemoryMb(rootPid, fs = defaultFs) {
  let pids;
  try {
    pids = processTree(rootPid, fs);
  } catch {
    return null;
  }
  let kb = 0;
  for (const pid of pids) {
    kb += memoryKb(pid, fs);
  }
  return Math.round(kb / 1024);
}

function memoryKb(pid, fs) {
  try {
    const match = /^Pss:\s+(\d+) kB/m.exec(
      fs.read(`/proc/${pid}/smaps_rollup`),
    );
    if (match) return Number(match[1]);
  } catch {
    // Fall back to VmRSS.
  }
  try {
    const match = /^VmRSS:\s+(\d+) kB/m.exec(fs.read(`/proc/${pid}/status`));
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

/** Cache a slow reading for `ttlMs`. */
export function cached(read, ttlMs = 5_000, now = Date.now) {
  let value;
  let at = -Infinity;
  return () => {
    if (now() - at >= ttlMs) {
      value = read();
      at = now();
    }
    return value;
  };
}
