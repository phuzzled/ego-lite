import { createHash, randomBytes } from "node:crypto";

/**
 * Keep the values of filled secrets out of the URLs and titles the SDK
 * prints itself (the snapshot header, page.url(), restore notices).
 *
 * A GET form puts a typed secret into the next URL (`?pw=<value>`). The host
 * redacts its snapshot body, but the SDK builds the header from tab URLs. The
 * SDK never sees a secret's value, so it redacts by what it can know:
 * - the name of each field page.fillSecret typed into (not secret), so the
 *   query parameter of that name is replaced wherever it appears;
 * - a salted SHA-256 of the value, computed in the page when it was filled,
 *   kept in this process only, so any URL part or word equal to the value
 *   is replaced too;
 * - when the host says the space had a secret filled but this process knows
 *   neither, every query value and fragment of a printed URL is hidden.
 */

const SALT = randomBytes(16).toString("hex");
const REDACTED = "[secret]";

type SpaceSecrets = { names: Set<string>; hashes: Set<string> };

const spaces = new Map<number, SpaceSecrets>();

/** The salt the page hashes a filled value with. */
export function secretHashSalt(): string {
  return SALT;
}

function hashOf(value: string): string {
  return createHash("sha256")
    .update(SALT + value)
    .digest("hex");
}

function entry(spaceId: number): SpaceSecrets {
  let known = spaces.get(spaceId);
  if (!known) {
    known = { names: new Set(), hashes: new Set() };
    spaces.set(spaceId, known);
  }
  return known;
}

/** Remember a filled field's name and its value's salted hash. */
export function recordSecretField(
  spaceId: number,
  field: { name?: unknown; hash?: unknown },
): void {
  const known = entry(spaceId);
  if (typeof field.name === "string" && field.name) known.names.add(field.name);
  if (typeof field.hash === "string" && /^[0-9a-f]{64}$/.test(field.hash)) {
    known.hashes.add(field.hash);
  }
}

/** Add field names remembered in an earlier round. */
export function rememberSecretFieldNames(
  spaceId: number,
  names: unknown,
): void {
  if (!Array.isArray(names)) return;
  for (const name of names) recordSecretField(spaceId, { name });
}

export function secretFieldNames(spaceId: number): string[] {
  return [...(spaces.get(spaceId)?.names ?? [])];
}

/** True when this process knows how to find a secret of this space. */
export function knowsSecrets(spaceId: number): boolean {
  const known = spaces.get(spaceId);
  return Boolean(known && (known.names.size > 0 || known.hashes.size > 0));
}

/** Forget a space's secrets (tests, a finished space). */
export function forgetSecrets(spaceId?: number): void {
  if (spaceId === undefined) spaces.clear();
  else spaces.delete(spaceId);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/**
 * Redact one URL. `conservative` hides every query value and the fragment
 * when the space had a secret filled that this process cannot identify.
 */
export function redactSecretUrl(
  url: string,
  spaceId: number,
  conservative = false,
): string {
  const known = spaces.get(spaceId);
  const hashes = known?.hashes ?? new Set<string>();
  const names = known?.names ?? new Set<string>();
  if (!conservative && hashes.size === 0 && names.size === 0) return url;
  const isSecret = (raw: string) =>
    raw.length > 0 && hashes.has(hashOf(decode(raw)));
  const queryStart = url.indexOf("?");
  const hashStart = url.indexOf("#");
  const end = (index: number) => (index < 0 ? url.length : index);
  const base = url.slice(0, end(queryStart >= 0 ? queryStart : hashStart));
  let query =
    queryStart >= 0
      ? url.slice(
          queryStart + 1,
          hashStart > queryStart ? hashStart : undefined,
        )
      : undefined;
  let fragment = hashStart >= 0 ? url.slice(hashStart + 1) : undefined;
  const path = base.replace(/[^/?#]+/g, (segment, offset: number) =>
    // Leave the scheme and host alone; check path segments only.
    offset > base.indexOf("//") + 2 && isSecret(segment) ? REDACTED : segment,
  );
  if (query !== undefined) {
    query = query
      .split("&")
      .map((pair) => {
        const at = pair.indexOf("=");
        if (at < 0) return isSecret(pair) || conservative ? REDACTED : pair;
        const key = pair.slice(0, at);
        const value = pair.slice(at + 1);
        if (conservative || names.has(decode(key)) || isSecret(value)) {
          return value ? `${key}=${REDACTED}` : pair;
        }
        return pair;
      })
      .join("&");
  }
  if (fragment !== undefined && fragment) {
    if (conservative || isSecret(fragment)) fragment = REDACTED;
    else {
      // A fragment can carry key=value pairs too (#pw=...).
      fragment = fragment
        .split("&")
        .map((pair) => {
          const at = pair.indexOf("=");
          if (at < 0) return pair;
          const key = pair.slice(0, at);
          const value = pair.slice(at + 1);
          return names.has(decode(key)) || isSecret(value)
            ? `${key}=${REDACTED}`
            : pair;
        })
        .join("&");
    }
  }
  return (
    path +
    (query !== undefined ? `?${query}` : "") +
    (fragment !== undefined ? `#${fragment}` : "")
  );
}

/** Redact every URL and every word equal to a filled value in `text`. */
export function redactSecretText(
  text: string,
  spaceId: number,
  conservative = false,
): string {
  if (!conservative && !knowsSecrets(spaceId)) return text;
  const hashes = spaces.get(spaceId)?.hashes ?? new Set<string>();
  // A URL with a scheme, or a word with a query or fragment (Chromium titles
  // a loading tab with its URL without the scheme).
  const withUrls = text.replace(
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+|[^\s"'<>]*[?#][^\s"'<>]+/gi,
    (url) => redactSecretUrl(url, spaceId, conservative),
  );
  if (hashes.size === 0) return withUrls;
  return withUrls.replace(/[^\s"'<>]{4,}/g, (word) =>
    hashes.has(hashOf(word)) ? REDACTED : word,
  );
}
