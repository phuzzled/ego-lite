import { parse } from "acorn";

import { PUBLIC_API_SCHEMA } from "./public-api-schema.js";

/**
 * A pre-run check for the mistakes Agents repeat in browser scripts: a static
 * import, a Page call without await, reading an HTTP status from an action
 * receipt, Page globals in Node.js code, Playwright-only names, and require().
 *
 * It only warns. Every rule is narrow on purpose: a false warning costs an
 * Agent a round, so a rule that cannot tell a Page from another object stays
 * silent. Disable it with `// ego-browser-lint-disable` on the first line.
 */

export type LintWarning = {
  line: number;
  rule:
    | "static-import"
    | "missing-await"
    | "receipt-status"
    | "page-global"
    | "playwright-api"
    | "require";
  message: string;
};

type Node = { type: string; start: number; end: number; [key: string]: any };
type Ancestor = { node: Node; key: string };
type ReceiverKind = "page" | "task" | "mouse" | "keyboard";

export const LINT_DISABLE_COMMENT = "// ego-browser-lint-disable";

const LINT_PREFIX = "[ego-browser:lint]";

/** Promise-returning methods by receiver, from the public API schema. */
const ASYNC_METHODS = asyncMethodsFromSchema();
/** Every public Page method, async or not. */
const PAGE_MEMBERS = new Set(
  PUBLIC_API_SCHEMA.filter((entry) => /^Page\.[^.]+$/.test(entry.name)).map(
    (entry) => entry.name.slice("Page.".length),
  ),
);

/**
 * Waiters are armed before the action that triggers them, so holding their
 * Promise without await is the intended pattern.
 */
const ARMED_WAITERS = new Set([
  "waitForEvent",
  "waitForFileChooser",
  "waitForResponse",
]);

const PROMISE_CHAIN_METHODS = new Set(["then", "catch", "finally"]);
const STRINGIFYING_CALLEES = new Set([
  "String",
  "Number",
  "Boolean",
  "cliLog",
  "JSON.stringify",
  "console.log",
  "console.info",
  "console.warn",
  "console.error",
]);
const RECEIPT_METHODS = new Set(["goto", "reload"]);
const RESPONSE_MEMBERS = new Set([
  "status",
  "ok",
  "json",
  "statusText",
  "headers",
]);
const PAGE_GLOBALS = new Set(["window", "document", "location"]);

const SELECTOR_ADVICE =
  'Pass a selector string to the action instead, such as await page.click("loc=role:button[name=\\"Save\\"]") or "text=Save".';
const READ_ADVICE =
  "Read the page with await page.evaluate(() => ...) or take a snapshot.";

const PLAYWRIGHT_ADVICE: Record<string, string> = {
  locator: SELECTOR_ADVICE,
  getByRole: SELECTOR_ADVICE,
  getByText: SELECTOR_ADVICE,
  getByLabel: SELECTOR_ADVICE,
  getByPlaceholder: SELECTOR_ADVICE,
  getByTestId: SELECTOR_ADVICE,
  getByAltText: SELECTOR_ADVICE,
  getByTitle: SELECTOR_ADVICE,
  frameLocator: SELECTOR_ADVICE,
  $: READ_ADVICE,
  $$: READ_ADVICE,
  $eval: READ_ADVICE,
  $$eval: READ_ADVICE,
  content: READ_ADVICE,
  textContent: READ_ADVICE,
  innerText: READ_ADVICE,
  innerHTML: READ_ADVICE,
  getAttribute: READ_ADVICE,
  inputValue: READ_ADVICE,
  isVisible: READ_ADVICE,
  isChecked: READ_ADVICE,
  waitForNavigation:
    "Use await page.waitForURL(...) or await page.waitForLoadState(...) after the action.",
  route: "Request interception is not available; read data with page.fetch().",
  context:
    "The TaskSpace is the browsing context; open Pages with await task.newPage().",
  type: "Use await page.fill(selector, text) or await page.keyboard.type(text).",
  check: "Use await page.click(selector) on the checkbox.",
  uncheck: "Use await page.click(selector) on the checkbox.",
  tap: "Use await page.click(selector).",
  setContent: "Navigate with await page.goto(url) instead.",
  setViewportSize:
    "The viewport belongs to the browser window; it cannot be set here.",
};

/** Lint one browser script. Never throws; an unparsable script has no warnings. */
export function lintScript(code: string): LintWarning[] {
  try {
    return lint(code);
  } catch {
    return [];
  }
}

/** Format warnings as stderr lines, or "" when there are none. */
export function formatLintWarnings(warnings: LintWarning[]): string {
  return warnings
    .map(
      (warning) => `${LINT_PREFIX} line ${warning.line}: ${warning.message}\n`,
    )
    .join("");
}

function lint(code: string): LintWarning[] {
  if (typeof code !== "string") return [];
  if (code.trimStart().split(/\r?\n/, 1)[0].trim() === LINT_DISABLE_COMMENT) {
    return [];
  }
  const ast = parseScript(code);
  if (!ast) return [];

  const declared = declaredNames(ast);
  const receivers = receiverNames(ast);
  const receiptVariables = new Set<string>();
  const warnings: LintWarning[] = [];
  const reportedGlobals = new Set<string>();
  const add = (node: Node, rule: LintWarning["rule"], message: string) => {
    warnings.push({ line: node.loc.start.line, rule, message });
  };
  const source = (node: Node) => code.slice(node.start, node.end);

  // Collect variables that hold a goto()/reload() receipt first, so a later
  // `.status` read is caught wherever it appears.
  walk(ast, [], (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      isReceiptCall(unwrapAwait(node.init))
    ) {
      receiptVariables.add(node.id.name);
    }
  });

  walk(ast, [], (node, ancestors) => {
    const parent = ancestors.at(-1);
    switch (node.type) {
      case "ImportDeclaration":
        add(node, "static-import", staticImportMessage(node));
        return;
      case "CallExpression": {
        const callee = node.callee;
        if (
          callee.type === "Identifier" &&
          callee.name === "require" &&
          !declared.has("require")
        ) {
          add(
            node,
            "require",
            `require() is not available in a browser script. Write const mod = await import(${requireTarget(node, source)});`,
          );
          return;
        }
        if (
          callee.type === "Identifier" &&
          callee.name === "expect" &&
          !declared.has("expect")
        ) {
          add(
            node,
            "playwright-api",
            "expect() is a Playwright test API and does not exist here. Check the value in plain JavaScript and throw an Error when it is wrong.",
          );
          return;
        }
        if (callee.type !== "MemberExpression" || callee.computed) return;
        const method = callee.property.name;
        const kind = receiverKind(callee.object, receivers);
        if (!kind) return;
        if (
          kind === "page" &&
          !PAGE_MEMBERS.has(method) &&
          Object.hasOwn(PLAYWRIGHT_ADVICE, method)
        ) {
          add(
            node,
            "playwright-api",
            `${source(callee)}() is a Playwright API; ego-browser Pages have no ${method}(). ${PLAYWRIGHT_ADVICE[method]}`,
          );
          return;
        }
        if (
          ASYNC_METHODS[kind].has(method) &&
          !ARMED_WAITERS.has(method) &&
          isPromiseMisused(node, ancestors)
        ) {
          const call = `${source(callee)}(${node.arguments.length ? "..." : ""})`;
          add(
            node,
            "missing-await",
            `${call} returns a Promise. Write await ${call}.`,
          );
        }
        return;
      }
      case "MemberExpression": {
        if (node.computed || !RESPONSE_MEMBERS.has(node.property.name)) return;
        const object = unwrapAwait(node.object);
        const fromReceipt =
          (object.type === "Identifier" && receiptVariables.has(object.name)) ||
          isReceiptCall(object);
        if (!fromReceipt) return;
        const call =
          parent?.node.type === "CallExpression" && parent.key === "callee";
        add(
          node,
          "receipt-status",
          `goto() and reload() return an action receipt, not a response; it has no ${node.property.name}${call ? "()" : ""}. Use await page.fetch(url) for an HTTP status.`,
        );
        return;
      }
      case "Identifier": {
        if (
          !PAGE_GLOBALS.has(node.name) ||
          declared.has(node.name) ||
          reportedGlobals.has(node.name) ||
          !isReference(node, parent) ||
          insideFunction(ancestors) ||
          (parent?.node.type === "UnaryExpression" &&
            parent.node.operator === "typeof")
        ) {
          return;
        }
        reportedGlobals.add(node.name);
        add(
          node,
          "page-global",
          `"${node.name}" is not defined in the script, which runs in Node.js. Put page code inside page.evaluate(() => ...).`,
        );
        return;
      }
    }
  });

  return warnings.sort((a, b) => a.line - b.line);
}

function parseScript(code: string): Node | null {
  const base = {
    ecmaVersion: "latest" as const,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    locations: true,
  };
  // Module mode accepts a static import so the lint can explain it; script
  // mode is the fallback for sloppy-mode-only syntax.
  for (const sourceType of ["module", "script"] as const) {
    try {
      return parse(code, { ...base, sourceType }) as unknown as Node;
    } catch {
      // Try the next mode; a real syntax error is reported when the run starts.
    }
  }
  return null;
}

function walk(
  node: Node,
  ancestors: Ancestor[],
  visit: (node: Node, ancestors: Ancestor[]) => void,
): void {
  visit(node, ancestors);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") {
      continue;
    }
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === "string") {
          walk(item, [...ancestors, { node, key }], visit);
        }
      }
    } else if (child && typeof child.type === "string") {
      walk(child, [...ancestors, { node, key }], visit);
    }
  }
}

function unwrapAwait(node: Node | null | undefined): Node {
  let current = node as Node;
  while (
    current &&
    (current.type === "AwaitExpression" ||
      current.type === "ParenthesizedExpression" ||
      current.type === "ChainExpression")
  ) {
    current =
      current.type === "AwaitExpression"
        ? current.argument
        : current.expression;
  }
  return current || ({ type: "Empty", start: 0, end: 0 } as Node);
}

function isReceiptCall(node: Node): boolean {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    RECEIPT_METHODS.has(node.callee.property.name)
  );
}

/**
 * Names that hold a Page or TaskSpace: assigned from a Page/TaskSpace factory,
 * or named like one (page, mainPage, popup, task).
 */
function receiverNames(ast: Node): Map<string, "page" | "task"> {
  const names = new Map<string, "page" | "task">();
  walk(ast, [], (node) => {
    let id: Node | undefined;
    let init: Node | undefined;
    if (node.type === "VariableDeclarator") {
      id = node.id;
      init = node.init;
    } else if (node.type === "AssignmentExpression") {
      id = node.left;
      init = node.right;
    }
    if (id?.type !== "Identifier" || !init) return;
    const value = unwrapAwait(init);
    if (value.type !== "CallExpression") return;
    const callee = value.callee;
    if (
      callee.type === "Identifier" &&
      ["taskSpace", "claimTaskSpace", "takeOverTaskSpace"].includes(callee.name)
    ) {
      names.set(id.name, "task");
    } else if (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      ["page", "newPage", "userPage", "adopt", "waitForEvent"].includes(
        callee.property.name,
      )
    ) {
      names.set(id.name, "page");
    }
  });
  return names;
}

function receiverKind(
  node: Node,
  receivers: Map<string, "page" | "task">,
): ReceiverKind | undefined {
  if (node.type === "Identifier") {
    const known = receivers.get(node.name);
    if (known) return known;
    if (/^task$|Task$|^task[A-Z0-9]/.test(node.name)) return "task";
    if (/^(page|popup|tab)(?:$|[A-Z0-9_])|(?:Page|Popup)$/.test(node.name)) {
      return "page";
    }
    return undefined;
  }
  if (node.type === "MemberExpression" && !node.computed) {
    const name = node.property.name;
    if (
      (name === "mouse" || name === "keyboard") &&
      receiverKind(node.object, receivers) === "page"
    ) {
      return name;
    }
    return undefined;
  }
  if (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    (node.callee.property.name === "page" ||
      node.callee.property.name === "userPage") &&
    receiverKind(node.callee.object, receivers) === "task"
  ) {
    return "page";
  }
  return undefined;
}

/**
 * Whether a Promise is used as if it were its value: discarded, stringified,
 * compared, tested, or read through a property other than then/catch/finally.
 * Awaited, returned, assigned, or passed-on Promises are left alone.
 */
function isPromiseMisused(call: Node, ancestors: Ancestor[]): boolean {
  const parent = ancestors.at(-1);
  if (!parent) return false;
  const { node, key } = parent;
  switch (node.type) {
    case "ExpressionStatement":
      return true;
    case "MemberExpression":
      return (
        key === "object" &&
        (node.computed || !PROMISE_CHAIN_METHODS.has(node.property.name))
      );
    case "TemplateLiteral":
    case "BinaryExpression":
      return true;
    case "UnaryExpression":
      return node.operator !== "void";
    case "IfStatement":
    case "WhileStatement":
    case "DoWhileStatement":
    case "ConditionalExpression":
      return key === "test";
    case "CallExpression":
      return (
        key === "arguments" && STRINGIFYING_CALLEES.has(calleeName(node.callee))
      );
    default:
      return false;
  }
}

function calleeName(node: Node): string {
  if (node.type === "Identifier") return node.name;
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier"
  ) {
    return `${node.object.name}.${node.property.name}`;
  }
  return "";
}

function isReference(node: Node, parent: Ancestor | undefined): boolean {
  if (!parent) return true;
  const { node: owner, key } = parent;
  if (owner.type === "MemberExpression" && key === "property") {
    return owner.computed;
  }
  if (
    (owner.type === "Property" ||
      owner.type === "MethodDefinition" ||
      owner.type === "PropertyDefinition") &&
    key === "key"
  ) {
    return owner.computed;
  }
  return ![
    "LabeledStatement",
    "BreakStatement",
    "ContinueStatement",
    "ImportSpecifier",
    "ImportDefaultSpecifier",
    "ImportNamespaceSpecifier",
    "ExportSpecifier",
    "MetaProperty",
  ].includes(owner.type);
}

function insideFunction(ancestors: Ancestor[]): boolean {
  return ancestors.some(({ node }) =>
    [
      "FunctionDeclaration",
      "FunctionExpression",
      "ArrowFunctionExpression",
    ].includes(node.type),
  );
}

/** Every name the script binds anywhere; a bound name is never a Page global. */
function declaredNames(ast: Node): Set<string> {
  const names = new Set<string>();
  const addPattern = (pattern: Node | null | undefined) => {
    if (!pattern) return;
    switch (pattern.type) {
      case "Identifier":
        names.add(pattern.name);
        break;
      case "ObjectPattern":
        for (const property of pattern.properties) {
          addPattern(
            property.type === "RestElement" ? property : property.value,
          );
        }
        break;
      case "ArrayPattern":
        for (const element of pattern.elements) addPattern(element);
        break;
      case "RestElement":
        addPattern(pattern.argument);
        break;
      case "AssignmentPattern":
        addPattern(pattern.left);
        break;
    }
  };
  walk(ast, [], (node) => {
    if (node.type === "VariableDeclarator") addPattern(node.id);
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      if (node.id) names.add(node.id.name);
      for (const param of node.params) addPattern(param);
    }
    if (node.type === "ClassDeclaration" && node.id) names.add(node.id.name);
    if (node.type === "CatchClause") addPattern(node.param);
    if (
      node.type === "ImportSpecifier" ||
      node.type === "ImportDefaultSpecifier" ||
      node.type === "ImportNamespaceSpecifier"
    ) {
      names.add(node.local.name);
    }
  });
  return names;
}

function staticImportMessage(node: Node): string {
  const from = JSON.stringify(node.source.value);
  const specifiers: Node[] = node.specifiers;
  const named = specifiers
    .filter((specifier) => specifier.type === "ImportSpecifier")
    .map((specifier) => {
      const imported =
        specifier.imported.type === "Identifier"
          ? specifier.imported.name
          : JSON.stringify(specifier.imported.value);
      return imported === specifier.local.name
        ? imported
        : `${imported}: ${specifier.local.name}`;
    });
  const defaultSpecifier = specifiers.find(
    (specifier) => specifier.type === "ImportDefaultSpecifier",
  );
  const namespace = specifiers.find(
    (specifier) => specifier.type === "ImportNamespaceSpecifier",
  );
  let replacement: string;
  if (namespace) {
    replacement = `const ${namespace.local.name} = await import(${from});`;
  } else if (defaultSpecifier || named.length > 0) {
    const parts = [
      ...(defaultSpecifier ? [`default: ${defaultSpecifier.local.name}`] : []),
      ...named,
    ];
    replacement = `const { ${parts.join(", ")} } = await import(${from});`;
  } else {
    replacement = `await import(${from});`;
  }
  return `static "import" does not work here; the script runs as a function body. Write ${replacement}`;
}

function requireTarget(node: Node, source: (node: Node) => string): string {
  const first = node.arguments[0];
  return first ? source(first) : '"module"';
}

function asyncMethodsFromSchema(): Record<ReceiverKind, Set<string>> {
  const methods: Record<ReceiverKind, Set<string>> = {
    page: new Set(),
    task: new Set(),
    mouse: new Set(),
    keyboard: new Set(),
  };
  const prefixes: Array<[string, ReceiverKind]> = [
    ["Page.mouse.", "mouse"],
    ["Page.keyboard.", "keyboard"],
    ["Page.", "page"],
    ["TaskSpace.", "task"],
  ];
  for (const entry of PUBLIC_API_SCHEMA) {
    if (!entry.signature.startsWith("await ")) continue;
    for (const [prefix, kind] of prefixes) {
      if (!entry.name.startsWith(prefix)) continue;
      const method = entry.name.slice(prefix.length);
      if (!method.includes(".")) methods[kind].add(method);
      break;
    }
  }
  return methods;
}
