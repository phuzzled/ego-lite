import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encode, lineReader } from "./control-channel.mjs";

describe("encode", () => {
  it("serialises to one JSON line", () => {
    assert.equal(encode({ id: 1, method: "x" }), '{"id":1,"method":"x"}\n');
  });
});

describe("lineReader", () => {
  it("splits several messages in one chunk", () => {
    const seen = [];
    const feed = lineReader((message) => seen.push(message));
    feed('{"a":1}\n{"b":2}\n');
    assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
  });

  it("joins a message split across chunk boundaries", () => {
    const seen = [];
    const feed = lineReader((message) => seen.push(message));
    feed('{"a":');
    feed("1}\n{");
    assert.deepEqual(seen, [{ a: 1 }]);
    feed('"b":2}');
    assert.deepEqual(seen, [{ a: 1 }]);
    feed("\n");
    assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
  });

  it("ignores blank and invalid lines", () => {
    const seen = [];
    const feed = lineReader((message) => seen.push(message));
    feed('\n   \nnot json\n{"ok":true}\n{broken\n');
    assert.deepEqual(seen, [{ ok: true }]);
  });

  it("round-trips encode", () => {
    const seen = [];
    const feed = lineReader((message) => seen.push(message));
    feed(encode({ id: 7, result: ["x"] }));
    assert.deepEqual(seen, [{ id: 7, result: ["x"] }]);
  });
});
