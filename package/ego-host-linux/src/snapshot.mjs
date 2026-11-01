/**
 * Snapshot engine: the Linux implementation of ego.snapshot().
 *
 * It reads the accessibility tree of a page and of every frame in it
 * (same-process iframes and out-of-process iframes), joins the frame trees at
 * their <iframe> owners, and prints the indented text format the SDK parses:
 *
 *   root
 *     heading "Title" level=1
 *     button "Save" [ref=1, loc=role:button[name="Save"]]
 *     link "Docs" url="https://example.com/docs" [ref=2, loc=href:/docs]
 *
 * Refs carry { refId, backendNodeId, frameId?, role, name, loc? }.
 * See docs/native-bindings-api.md and docs/native-snapshot-ref-requirement.md.
 */
import { invalidArgument } from "./errors.mjs";

const SCOPES = new Set(["full_page", "only_within_viewport", "subtree"]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "iframe",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "scrollbar",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

const ROLE_ALIASES = {
  RootWebArea: "root",
  WebArea: "root",
  generic: "container",
  none: "container",
  presentation: "container",
  GenericContainer: "container",
  LayoutTable: "container",
  LayoutTableRow: "container",
  LayoutTableCell: "container",
  StaticText: "text",
  Iframe: "iframe",
  IframePresentational: "iframe",
  img: "image",
  Canvas: "canvas",
  SvgRoot: "svg_root",
  LabelText: "label",
  textField: "textbox",
  TextField: "textbox",
  ListBoxOption: "option",
};

const DROPPED_ROLES = new Set(["InlineTextBox", "LineBreak", "ListMarker"]);

/** Roles never advertised as role: locators, because they are renamed here. */
const NO_ROLE_LOCATOR = new Set([
  "root",
  "container",
  "text",
  "iframe",
  "svg_root",
  "label",
]);

export function validateSnapshotOptions(options) {
  if (options === undefined) return {};
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw invalidArgument("snapshot(options) requires an object");
  }
  if (options.scope !== undefined && !SCOPES.has(options.scope)) {
    throw invalidArgument(`Unknown snapshot scope: ${options.scope}`);
  }
  if (options.scope === "subtree" && typeof options.root !== "number") {
    throw invalidArgument("subtree scope requires a numeric root");
  }
  if (
    options.maxResultLength !== undefined &&
    (typeof options.maxResultLength !== "number" || options.maxResultLength < 0)
  ) {
    throw invalidArgument("maxResultLength must be a non-negative number");
  }
  return options;
}

export async function captureSnapshot(cdp, targetId, options = {}) {
  const sessions = [];
  const attach = async (id) => {
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId: id,
      flatten: true,
    });
    sessions.push(sessionId);
    return sessionId;
  };
  try {
    const pageSessionId = await attach(targetId);
    const frames = await collectFrames(cdp, pageSessionId, sessions);
    const contexts = await Promise.all(
      frames.map((frame) => loadContext(cdp, frame)),
    );
    const viewport =
      options.scope === "only_within_viewport"
        ? await readViewport(cdp, pageSessionId)
        : null;
    const pageOrigin = await readOrigin(cdp, pageSessionId);
    return renderSnapshot(contexts, { ...options, viewport, pageOrigin });
  } finally {
    await Promise.allSettled(
      sessions
        .reverse()
        .map((sessionId) =>
          cdp.send("Target.detachFromTarget", { sessionId }, undefined, 5_000),
        ),
    );
  }
}

/**
 * Every frame of the page with the session that can read it. Out-of-process
 * iframes are found through auto-attach, recursively.
 */
async function collectFrames(cdp, pageSessionId, sessions) {
  const frames = [];
  const visit = async (sessionId, parentSessionId) => {
    const childSessions = [];
    const unsubscribe = cdp.onMessage((_text, message) => {
      if (
        message.method === "Target.attachedToTarget" &&
        message.sessionId === sessionId &&
        message.params?.targetInfo?.type === "iframe"
      ) {
        childSessions.push(message.params.sessionId);
      }
    });
    try {
      await cdp.send("DOM.getDocument", { depth: 0 }, sessionId);
      await cdp.send(
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        sessionId,
      );
      // Attach events for existing children may trail the reply slightly.
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      unsubscribe();
    }
    sessions.push(...childSessions);

    const { frameTree } = await cdp.send("Page.getFrameTree", {}, sessionId);
    const remoteIds = new Set();
    const childRoots = await Promise.all(
      childSessions.map(async (childSessionId) => {
        const tree = await cdp.send("Page.getFrameTree", {}, childSessionId);
        remoteIds.add(tree.frameTree.frame.id);
        return childSessionId;
      }),
    );
    const walk = (tree, parentFrameId, isSessionRoot) => {
      const frameId = tree.frame.id;
      if (remoteIds.has(frameId)) return;
      frames.push({
        sessionId,
        frameId,
        parentFrameId,
        ownerSessionId: isSessionRoot ? parentSessionId : sessionId,
        isPage: isSessionRoot && parentSessionId === undefined,
      });
      for (const child of tree.childFrames || []) walk(child, frameId, false);
    };
    walk(frameTree, frameTree.frame.parentId, true);
    for (const childSessionId of childRoots) {
      await visit(childSessionId, sessionId);
    }
  };
  await visit(pageSessionId, undefined);
  return frames;
}

async function loadContext(cdp, frame) {
  const [ax, owner, layout] = await Promise.all([
    cdp.send(
      "Accessibility.getFullAXTree",
      { frameId: frame.frameId },
      frame.sessionId,
    ),
    frame.isPage
      ? Promise.resolve(null)
      : cdp
          .send(
            "DOM.getFrameOwner",
            { frameId: frame.frameId },
            frame.ownerSessionId,
          )
          .catch(() => null),
    frame.isPage
      ? cdp
          .send(
            "DOMSnapshot.captureSnapshot",
            { computedStyles: [], includeDOMRects: true },
            frame.sessionId,
          )
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    ...frame,
    nodes: ax.nodes || [],
    ownerBackendNodeId: owner?.backendNodeId,
    layout: layout ? indexLayout(layout, frame.frameId) : null,
  };
}

/** Bounds and click handlers by backendNodeId for the page document. */
function indexLayout(snapshot, frameId) {
  const bounds = new Map();
  const clickable = new Set();
  const document =
    snapshot.documents.find(
      (doc) => snapshot.strings[doc.frameId] === frameId,
    ) || snapshot.documents[0];
  if (!document) return { bounds, clickable };
  const backendIds = document.nodes.backendNodeId || [];
  for (const index of document.nodes.isClickable?.index || []) {
    clickable.add(backendIds[index]);
  }
  const { nodeIndex = [], bounds: rects = [] } = document.layout || {};
  for (let i = 0; i < nodeIndex.length; i += 1) {
    bounds.set(backendIds[nodeIndex[i]], rects[i]);
  }
  return { bounds, clickable };
}

async function readViewport(cdp, sessionId) {
  const metrics = await cdp.send("Page.getLayoutMetrics", {}, sessionId);
  const view = metrics.cssLayoutViewport || metrics.layoutViewport;
  return {
    x: view.pageX,
    y: view.pageY,
    width: view.clientWidth,
    height: view.clientHeight,
  };
}

async function readOrigin(cdp, sessionId) {
  try {
    const { result } = await cdp.send(
      "Runtime.evaluate",
      { expression: "location.origin", returnByValue: true },
      sessionId,
      5_000,
    );
    return typeof result?.value === "string" ? result.value : null;
  } catch {
    return null;
  }
}

/**
 * Pure part of the engine: AX contexts in, { content, refs } out.
 * Exported for tests.
 */
export function renderSnapshot(contexts, options = {}) {
  const page = contexts.find((context) => context.isPage) || contexts[0];
  const byOwner = new Map();
  for (const context of contexts) {
    if (context === page || context.ownerBackendNodeId === undefined) continue;
    byOwner.set(
      `${context.ownerSessionId}\u0000${context.ownerBackendNodeId}`,
      context,
    );
  }
  for (const context of contexts) {
    context.byId = new Map(context.nodes.map((node) => [node.nodeId, node]));
    context.locatorCounts = countLocators(context, options.pageOrigin);
  }

  const build = (context, node, visible) => {
    if (!node) return [];
    const rawRole = axValue(node.role);
    if (DROPPED_ROLES.has(rawRole)) return [];
    const inView =
      visible || isInViewport(context, node.backendDOMNodeId, options.viewport);
    const children = (node.childIds || []).flatMap((id) =>
      build(context, context.byId.get(id), visible),
    );
    const owned = byOwner.get(
      `${context.sessionId}\u0000${node.backendDOMNodeId}`,
    );
    if (owned) {
      const root = owned.nodes.find((candidate) => !candidate.parentId);
      // Frame content is shown whenever its <iframe> is shown.
      const frameChildren = root
        ? build(owned, root, inView || visible).flatMap((child) =>
            child.role === "root" ? child.children : [child],
          )
        : [];
      children.push(...frameChildren);
    }
    if (node.ignored) return children;

    const role = mapRole(rawRole, owned);
    const name = cleanText(axValue(node.name));
    if (role === "text") {
      if (!name || !inView) return [];
      return [{ role, name, children: [] }];
    }
    if (role === "root" && context !== page && !options.subtreeRoot) {
      return children;
    }
    const interactive =
      role !== "root" &&
      (INTERACTIVE_ROLES.has(role) ||
        Boolean(owned) ||
        hasProperty(node, "focusable") ||
        Boolean(context.layout?.clickable.has(node.backendDOMNodeId)));
    const keptChildren = children.filter(
      (child) => !(child.role === "text" && child.name === name),
    );
    if (!inView && keptChildren.length === 0 && role !== "root") return [];
    return [
      {
        role,
        name,
        node,
        context,
        interactive,
        props: nodeProps(role, node),
        children: keptChildren,
      },
    ];
  };

  let tree;
  if (options.scope === "subtree") {
    const matches = contexts.flatMap((context) =>
      context.nodes
        .filter((node) => node.backendDOMNodeId === options.root)
        .map((node) => ({ context, node })),
    );
    const owners = new Set(matches.map((match) => match.context));
    if (owners.size === 0) {
      throw snapshotError(`Snapshot root not found: ${options.root}`);
    }
    if (owners.size > 1) {
      throw snapshotError(
        `Snapshot root ${options.root} is ambiguous across frames`,
      );
    }
    const { context, node } = matches[0];
    tree = build(context, node, true);
  } else {
    const root = page.nodes.find((node) => !node.parentId);
    tree = build(page, root, options.scope !== "only_within_viewport");
  }

  if (options.interactiveOnly) tree = keepInteractive(tree);
  tree = tree.flatMap(compact);

  const refs = [];
  const lines = [];
  const withMarks = options.includeActionMarks !== false;
  const withLocators = options.includeStableLocator !== false;
  const emit = (item, depth) => {
    let line = item.role;
    if (item.name) line += ` ${JSON.stringify(item.name)}`;
    if (item.props) line += item.props;
    if (item.interactive) {
      const refId = refs.length + 1;
      const loc = withLocators
        ? stableLocator(item, options.pageOrigin)
        : undefined;
      refs.push({
        refId,
        backendNodeId: item.node.backendDOMNodeId,
        ...(item.context === page ? {} : { frameId: item.context.frameId }),
        role: item.role,
        name: item.name,
        ...(loc ? { loc } : {}),
      });
      if (withMarks) line += ` [ref=${refId}${loc ? `, loc=${loc}` : ""}]`;
    }
    lines.push(`${"  ".repeat(depth)}${line}`);
    for (const child of item.children) emit(child, depth + 1);
  };
  for (const item of tree) emit(item, 0);

  let content = lines.join("\n");
  if (options.maxResultLength > 0 && content.length > options.maxResultLength) {
    const cut = content.lastIndexOf("\n", options.maxResultLength);
    content = content.slice(0, cut > 0 ? cut : options.maxResultLength);
    const kept = [...content.matchAll(/\[ref=(\d+)/g)];
    const limit = kept.length ? Number(kept.at(-1)[1]) : 0;
    return { content, refs: refs.filter((ref) => ref.refId <= limit) };
  }
  return { content, refs };
}

function keepInteractive(items) {
  return items.flatMap((item) => {
    if (item.role === "text") return [];
    const children = keepInteractive(item.children);
    if (item.interactive || item.role === "root")
      return [{ ...item, children }];
    return children.length ? [{ ...item, children }] : [];
  });
}

/** docs/native-snapshot-ref-requirement.md: drop empty wrappers. */
function compact(item) {
  const children = item.children.flatMap(compact);
  if (item.role === "container" && !item.name && !item.interactive) {
    if (children.length === 0) return [];
    if (children.length === 1) return children;
  }
  return [{ ...item, children }];
}

function stableLocator(item, pageOrigin) {
  if (item.role === "link") {
    const key = hrefKey(axProperty(item.node, "url"), pageOrigin);
    return key && item.context.locatorCounts.get(`href\u0000${key}`) === 1
      ? `href:${key}`
      : undefined;
  }
  if (!item.name || NO_ROLE_LOCATOR.has(item.role)) return undefined;
  const key = `role\u0000${item.role}\u0000${item.name}`;
  return item.context.locatorCounts.get(key) === 1
    ? `role:${item.role}[name=${JSON.stringify(item.name)}]`
    : undefined;
}

function countLocators(context, pageOrigin) {
  const counts = new Map();
  const bump = (key) => counts.set(key, (counts.get(key) || 0) + 1);
  for (const node of context.nodes) {
    if (node.ignored) continue;
    const role = mapRole(axValue(node.role));
    const name = cleanText(axValue(node.name));
    if (role === "link") {
      const key = hrefKey(axProperty(node, "url"), pageOrigin);
      if (key) bump(`href\u0000${key}`);
    }
    if (name) bump(`role\u0000${role}\u0000${name}`);
  }
  return counts;
}

/** Match the SDK href locator: path+query+hash, or the full URL off-origin. */
function hrefKey(url, pageOrigin) {
  if (typeof url !== "string" || !url) return undefined;
  try {
    const parsed = new URL(url);
    if (pageOrigin && parsed.origin === pageOrigin) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
}

function nodeProps(role, node) {
  let props = "";
  const level = axProperty(node, "level");
  if (role === "heading" && level) props += ` level=${level}`;
  const checked = axProperty(node, "checked");
  if (checked === "true" || checked === true) props += " checked";
  if (checked === "mixed") props += " checked=mixed";
  if (axProperty(node, "disabled") === true) props += " disabled";
  if (axProperty(node, "expanded") === true) props += " expanded";
  if (axProperty(node, "selected") === true) props += " selected";
  const value = cleanText(axValue(node.value));
  if (
    value &&
    ["textbox", "searchbox", "combobox", "spinbutton", "slider"].includes(role)
  ) {
    props += ` value=${JSON.stringify(value)}`;
  }
  if (role === "link") {
    const url = axProperty(node, "url");
    if (url) props += ` url=${JSON.stringify(url)}`;
  }
  return props;
}

function mapRole(rawRole, ownsFrame = false) {
  if (ownsFrame) return "iframe";
  if (!rawRole) return "container";
  return ROLE_ALIASES[rawRole] || rawRole.toLowerCase();
}

function isInViewport(context, backendNodeId, viewport) {
  if (!viewport) return true;
  const rect = context.layout?.bounds.get(backendNodeId);
  if (!rect) return false;
  const [x, y, width, height] = rect;
  return (
    x < viewport.x + viewport.width &&
    x + width > viewport.x &&
    y < viewport.y + viewport.height &&
    y + height > viewport.y
  );
}

function hasProperty(node, name) {
  return axProperty(node, name) === true;
}

function axProperty(node, name) {
  const property = (node.properties || []).find((item) => item.name === name);
  return property ? axValue(property.value) : undefined;
}

function axValue(value) {
  return value && typeof value === "object" ? value.value : value;
}

function cleanText(text) {
  if (typeof text !== "string") return "";
  return text.replace(/\s+/g, " ").trim();
}

function snapshotError(message) {
  const error = new Error(message);
  error.error_code = "EGO_SNAPSHOT_FAILED";
  return error;
}
