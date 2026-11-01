/**
 * page.structuredData(): what a page says about itself in machine-readable
 * form: JSON-LD, OpenGraph and Twitter card tags, the meta description,
 * the canonical URL, and schema.org microdata. Runs inside the page.
 */

export type StructuredData = {
  url: string;
  title: string;
  description?: string;
  canonical?: string;
  lang?: string;
  jsonLd: unknown[];
  openGraph: Record<string, string | string[]>;
  twitter: Record<string, string>;
  microdata: unknown[];
  errors?: string[];
};

/** Runs in the page. Self-contained. */
export function extractStructuredData(): any {
  const doc = document;
  const errors: string[] = [];

  const jsonLd: unknown[] = [];
  for (const script of Array.from(
    doc.querySelectorAll('script[type="application/ld+json"]'),
  )) {
    const text = (script.textContent || "").trim();
    if (!text) continue;
    try {
      const value = JSON.parse(text);
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        // Flatten @graph so each entity is one entry.
        if (item && typeof item === "object" && Array.isArray(item["@graph"])) {
          const context = item["@context"];
          for (const node of item["@graph"]) {
            jsonLd.push(
              context && node && typeof node === "object" && !node["@context"]
                ? { "@context": context, ...node }
                : node,
            );
          }
        } else {
          jsonLd.push(item);
        }
      }
    } catch (error) {
      errors.push(`invalid JSON-LD: ${(error as Error).message}`);
    }
  }

  const openGraph: Record<string, string | string[]> = {};
  const twitter: Record<string, string> = {};
  for (const meta of Array.from(doc.querySelectorAll("meta"))) {
    const key =
      meta.getAttribute("property") || meta.getAttribute("name") || "";
    const content = meta.getAttribute("content");
    if (!content) continue;
    if (/^(og|article|book|profile|video|music):/i.test(key)) {
      const name = key.toLowerCase();
      const existing = openGraph[name];
      if (existing === undefined) openGraph[name] = content;
      else if (Array.isArray(existing)) existing.push(content);
      else openGraph[name] = [existing, content];
    } else if (/^twitter:/i.test(key)) {
      twitter[key.toLowerCase()] = content;
    }
  }

  function absolute(value: string | null): string | undefined {
    if (!value) return undefined;
    try {
      return new URL(value, doc.baseURI).href;
    } catch {
      return value;
    }
  }

  function itemValue(element: Element): unknown {
    if (element.hasAttribute("itemscope")) return item(element);
    const tag = element.tagName;
    if (element.hasAttribute("content")) return element.getAttribute("content");
    if (tag === "META") return element.getAttribute("content") || "";
    if (["A", "AREA", "LINK"].includes(tag)) {
      return absolute(element.getAttribute("href")) || "";
    }
    if (
      ["AUDIO", "EMBED", "IFRAME", "IMG", "SOURCE", "TRACK", "VIDEO"].includes(
        tag,
      )
    ) {
      return absolute(element.getAttribute("src")) || "";
    }
    if (tag === "TIME") {
      return (
        element.getAttribute("datetime") || (element.textContent || "").trim()
      );
    }
    if (tag === "DATA" || tag === "METER") {
      return element.getAttribute("value") || "";
    }
    return (element.textContent || "").replace(/\s+/g, " ").trim();
  }

  function item(scope: Element, depth = 0): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const type = scope.getAttribute("itemtype");
    if (type)
      result["@type"] = type
        .split(/\s+/)
        .map((t) => t.replace(/^https?:\/\/schema\.org\//, ""));
    const id = scope.getAttribute("itemid");
    if (id) result["@id"] = id;
    if (depth > 8) return result;
    const properties: Record<string, unknown[]> = {};
    // Properties are the itemprop descendants whose nearest scope is this one.
    const walk = (element: Element) => {
      for (const child of Array.from(element.children)) {
        if (child.hasAttribute("itemprop")) {
          const value = child.hasAttribute("itemscope")
            ? item(child, depth + 1)
            : itemValue(child);
          for (const name of (child.getAttribute("itemprop") || "").split(
            /\s+/,
          )) {
            if (!name) continue;
            (properties[name] ||= []).push(value);
          }
        }
        if (!child.hasAttribute("itemscope")) walk(child);
      }
    };
    walk(scope);
    for (const [name, values] of Object.entries(properties)) {
      result[name] = values.length === 1 ? values[0] : values;
    }
    return result;
  }

  const microdata = Array.from(doc.querySelectorAll("[itemscope]"))
    .filter((element) => !element.hasAttribute("itemprop"))
    .slice(0, 100)
    .map((element) => item(element));

  const description =
    doc.querySelector('meta[name="description"]')?.getAttribute("content") ||
    undefined;
  const canonical =
    absolute(
      doc.querySelector('link[rel="canonical"]')?.getAttribute("href") || null,
    ) || undefined;
  const lang = doc.documentElement.getAttribute("lang") || undefined;
  return {
    url: location.href,
    title: doc.title,
    ...(description ? { description } : {}),
    ...(canonical ? { canonical } : {}),
    ...(lang ? { lang } : {}),
    jsonLd,
    openGraph,
    twitter,
    microdata,
    ...(errors.length ? { errors } : {}),
  };
}
