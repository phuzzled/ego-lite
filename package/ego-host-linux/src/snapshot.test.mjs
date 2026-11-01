import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderSnapshot, validateSnapshotOptions } from "./snapshot.mjs";

let counter = 0;

/** Build an AXNode; children are given as node objects and linked by id. */
function ax(role, name, { children = [], backend, props = [], ignored } = {}) {
  counter += 1;
  return {
    nodeId: `n${counter}`,
    ignored: Boolean(ignored),
    role: { value: role },
    name: { value: name ?? "" },
    properties: props.map(([key, value]) => ({ name: key, value: { value } })),
    childIds: children.map((child) => child.nodeId),
    backendDOMNodeId: backend ?? 1000 + counter,
    _children: children,
  };
}

/** Flatten a node tree into the nodes array with parentId set. */
function flatten(root) {
  const nodes = [];
  const walk = (node, parentId) => {
    const { _children, ...rest } = node;
    nodes.push(parentId ? { ...rest, parentId } : rest);
    for (const child of _children) walk(child, node.nodeId);
  };
  walk(root);
  return nodes;
}

function pageContext(root, extra = {}) {
  return {
    sessionId: "page",
    frameId: "F0",
    isPage: true,
    nodes: flatten(root),
    layout: null,
    ...extra,
  };
}

const page = (...children) => ax("RootWebArea", "", { children });
const lines = (result) => result.content.split("\n");

describe("renderSnapshot", () => {
  it("prints root first with two-space indentation and a role locator", () => {
    const button = ax("button", "Save", { backend: 7 });
    const heading = ax("heading", "Title", { props: [["level", 1]] });
    const result = renderSnapshot([pageContext(page(heading, button))]);
    assert.deepEqual(lines(result), [
      "root",
      '  heading "Title" level=1',
      '  button "Save" [ref=1, loc=role:button[name="Save"]]',
    ]);
    assert.deepEqual(result.refs, [
      {
        refId: 1,
        backendNodeId: 7,
        role: "button",
        name: "Save",
        loc: 'role:button[name="Save"]',
      },
    ]);
  });

  it("gives refs but no loc to buttons with the same name", () => {
    const result = renderSnapshot([
      pageContext(page(ax("button", "Go"), ax("button", "Go"))),
    ]);
    assert.equal(result.refs.length, 2);
    assert.ok(result.refs.every((ref) => !("loc" in ref)));
    assert.deepEqual(lines(result).slice(1), [
      '  button "Go" [ref=1]',
      '  button "Go" [ref=2]',
    ]);
  });

  it("uses href locators for unique same-origin links", () => {
    const link = ax("link", "Docs", {
      props: [["url", "https://site.test/docs?a=1#top"]],
    });
    const result = renderSnapshot([pageContext(page(link))], {
      pageOrigin: "https://site.test",
    });
    assert.equal(result.refs[0].loc, "href:/docs?a=1#top");
    assert.match(result.content, /\[ref=1, loc=href:\/docs\?a=1#top\]/);
  });

  it("uses the full URL for off-origin links", () => {
    const link = ax("link", "Out", {
      props: [["url", "https://other.test/x"]],
    });
    const result = renderSnapshot([pageContext(page(link))], {
      pageOrigin: "https://site.test",
    });
    assert.equal(result.refs[0].loc, "href:https://other.test/x");
  });

  it("gives duplicate hrefs no loc at all", () => {
    const url = "https://site.test/same";
    const result = renderSnapshot(
      [
        pageContext(
          page(
            ax("link", "One", { props: [["url", url]] }),
            ax("link", "Two", { props: [["url", url]] }),
          ),
        ),
      ],
      { pageOrigin: "https://site.test" },
    );
    assert.equal(result.refs.length, 2);
    assert.ok(result.refs.every((ref) => !("loc" in ref)));
    assert.ok(!result.content.includes("loc="));
  });

  it("drops StaticText that duplicates its parent's name, and empty text", () => {
    const button = ax("button", "Save", {
      children: [ax("StaticText", "Save")],
    });
    const para = ax("paragraph", "", {
      children: [ax("StaticText", "Hello"), ax("StaticText", "   ")],
    });
    const result = renderSnapshot([pageContext(page(button, para))]);
    const out = lines(result);
    assert.deepEqual(out, [
      "root",
      '  button "Save" [ref=1, loc=role:button[name="Save"]]',
      "  paragraph",
      '    text "Hello"',
    ]);
  });

  it("drops text that repeats its parent's name through a wrapper", () => {
    const heading = ax("heading", "Jobs", {
      props: [["level", 2]],
      children: [ax("generic", "", { children: [ax("StaticText", "Jobs")] })],
    });
    const result = renderSnapshot([pageContext(page(heading))]);
    assert.deepEqual(lines(result), ["root", '  heading "Jobs" level=2']);
  });

  it("strips icon-font glyphs and gives such names no role locator", () => {
    const button = ax("button", "Sort ", {
      children: [ax("StaticText", "")],
    });
    const result = renderSnapshot([pageContext(page(button))]);
    assert.deepEqual(lines(result), ["root", '  button "Sort" [ref=1]']);
    assert.ok(!("loc" in result.refs[0]));
  });

  it("replaces an unnamed single-child container with the child", () => {
    const inner = ax("heading", "H", { props: [["level", 2]] });
    const wrapper = ax("generic", "", { children: [inner] });
    const result = renderSnapshot([pageContext(page(wrapper))]);
    assert.deepEqual(lines(result), ["root", '  heading "H" level=2']);
  });

  it("skips ignored nodes but keeps their children", () => {
    const ignored = ax("generic", "", {
      ignored: true,
      children: [ax("button", "Inner")],
    });
    const result = renderSnapshot([pageContext(page(ignored))]);
    assert.equal(result.refs.length, 1);
    assert.equal(result.refs[0].name, "Inner");
  });

  it("stitches an out-of-process iframe under an iframe line", () => {
    const frameNode = ax("Iframe", "", { backend: 50 });
    const pageCtx = pageContext(page(ax("button", "Outer"), frameNode));
    const inner = ax("RootWebArea", "", {
      children: [ax("button", "Inner", { backend: 77 })],
    });
    const frameCtx = {
      sessionId: "child",
      frameId: "F1",
      isPage: false,
      ownerSessionId: "page",
      ownerBackendNodeId: 50,
      nodes: flatten(inner),
      layout: null,
    };
    const result = renderSnapshot([pageCtx, frameCtx]);
    assert.deepEqual(lines(result), [
      "root",
      '  button "Outer" [ref=1, loc=role:button[name="Outer"]]',
      "  iframe [ref=2]",
      '    button "Inner" [ref=3, loc=role:button[name="Inner"]]',
    ]);
    assert.equal(result.refs[0].frameId, undefined);
    assert.equal(result.refs[2].frameId, "F1");
    assert.equal(result.refs[2].backendNodeId, 77);
  });

  it("only_within_viewport drops nodes outside the viewport", () => {
    const inside = ax("button", "Inside", { backend: 1 });
    const outside = ax("button", "Outside", { backend: 2 });
    const ctx = pageContext(page(inside, outside), {
      layout: {
        bounds: new Map([
          [1, [10, 10, 50, 20]],
          [2, [10, 5000, 50, 20]],
        ]),
        clickable: new Set(),
      },
    });
    const result = renderSnapshot([ctx], {
      scope: "only_within_viewport",
      viewport: { x: 0, y: 0, width: 800, height: 600 },
    });
    assert.deepEqual(
      result.refs.map((ref) => ref.name),
      ["Inside"],
    );
    assert.ok(!result.content.includes("Outside"));
  });

  it("interactiveOnly keeps interactive nodes and their ancestors", () => {
    const tree = page(
      ax("heading", "Skip me"),
      ax("navigation", "Nav", {
        children: [ax("button", "A"), ax("button", "B")],
      }),
    );
    const result = renderSnapshot([pageContext(tree)], {
      interactiveOnly: true,
    });
    assert.deepEqual(lines(result), [
      "root",
      '  navigation "Nav"',
      '    button "A" [ref=1, loc=role:button[name="A"]]',
      '    button "B" [ref=2, loc=role:button[name="B"]]',
    ]);
  });

  it("includeActionMarks:false prints no refs marks but returns refs", () => {
    const result = renderSnapshot([pageContext(page(ax("button", "Save")))], {
      includeActionMarks: false,
    });
    assert.ok(!result.content.includes("[ref="));
    assert.equal(result.refs.length, 1);
  });

  it("renders a subtree from options.root", () => {
    const target = ax("navigation", "Nav", {
      backend: 99,
      children: [ax("button", "A")],
    });
    const result = renderSnapshot(
      [pageContext(page(ax("button", "Other"), target))],
      { scope: "subtree", root: 99 },
    );
    assert.equal(lines(result)[0], 'navigation "Nav"');
    assert.ok(!result.content.includes("Other"));
    assert.equal(result.refs.length, 1);
  });

  it("maxResultLength truncates at a line boundary and drops later refs", () => {
    const tree = page(ax("button", "A"), ax("button", "B"), ax("button", "C"));
    const full = renderSnapshot([pageContext(tree)]);
    const fullLines = lines(full);
    const max = fullLines[0].length + 1 + fullLines[1].length + 3;
    const result = renderSnapshot([pageContext(tree)], {
      maxResultLength: max,
    });
    assert.deepEqual(lines(result), fullLines.slice(0, 2));
    assert.deepEqual(
      result.refs.map((ref) => ref.refId),
      [1],
    );
  });

  it("maxResultLength keeps every ref printed before the cut", () => {
    const tree = page(ax("button", "A"), ax("button", "B"), ax("button", "C"));
    const fullLines = lines(renderSnapshot([pageContext(tree)]));
    const max = fullLines.slice(0, 3).join("\n").length + 3;
    const result = renderSnapshot([pageContext(tree)], {
      maxResultLength: max,
    });
    assert.deepEqual(lines(result), fullLines.slice(0, 3));
    assert.deepEqual(
      result.refs.map((ref) => ref.refId),
      [1, 2],
    );
  });

  it("subtree throws EGO_SNAPSHOT_FAILED when root is missing", () => {
    assert.throws(
      () =>
        renderSnapshot([pageContext(page(ax("button", "A")))], {
          scope: "subtree",
          root: 424242,
        }),
      (error) =>
        error instanceof Error && error.error_code === "EGO_SNAPSHOT_FAILED",
    );
  });

  it("subtree throws EGO_SNAPSHOT_FAILED when root is in two contexts", () => {
    const pageCtx = pageContext(
      page(ax("button", "A", { backend: 5 }), ax("Iframe", "", { backend: 6 })),
    );
    const frameCtx = {
      sessionId: "child",
      frameId: "F1",
      isPage: false,
      ownerSessionId: "page",
      ownerBackendNodeId: 6,
      nodes: flatten(
        ax("RootWebArea", "", {
          children: [ax("button", "B", { backend: 5 })],
        }),
      ),
      layout: null,
    };
    assert.throws(
      () => renderSnapshot([pageCtx, frameCtx], { scope: "subtree", root: 5 }),
      (error) => error.error_code === "EGO_SNAPSHOT_FAILED",
    );
  });
});

describe("validateSnapshotOptions", () => {
  const rejects = (options) =>
    assert.throws(
      () => validateSnapshotOptions(options),
      (error) =>
        error instanceof TypeError &&
        error.error_code === "EGO_INVALID_ARGUMENT",
    );

  it("accepts undefined and valid objects", () => {
    assert.deepEqual(validateSnapshotOptions(undefined), {});
    const options = { scope: "subtree", root: 3, maxResultLength: 0 };
    assert.equal(validateSnapshotOptions(options), options);
  });

  it("rejects non-objects", () => {
    rejects(null);
    rejects("full_page");
    rejects(5);
    rejects([]);
  });

  it("rejects an unknown scope", () => rejects({ scope: "everything" }));

  it("rejects subtree without a numeric root", () => {
    rejects({ scope: "subtree" });
    rejects({ scope: "subtree", root: "7" });
  });

  it("rejects a negative maxResultLength", () => {
    rejects({ maxResultLength: -1 });
    rejects({ maxResultLength: "10" });
  });
});
