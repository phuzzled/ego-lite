import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  connectRunningDaemon,
  encode,
  lineReader,
} from "./control-channel.mjs";
import { controlSocketPath, daemonInfoFile } from "./paths.mjs";

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

describe("connectRunningDaemon", () => {
  it("finds a daemon started from a shell with another XDG_RUNTIME_DIR", async () => {
    const home = mkdtempSync(join(tmpdir(), "ego-lite-cc-"));
    const daemonEnv = {
      XDG_STATE_HOME: home,
      XDG_RUNTIME_DIR: join(home, "a"),
    };
    const socket = controlSocketPath(daemonEnv);
    mkdirSync(dirname(socket), { recursive: true });
    const server = createServer((connection) => {
      connection.setEncoding("utf8");
      connection.on(
        "data",
        lineReader(({ id }) =>
          connection.write(encode({ id, result: "pong" })),
        ),
      );
    });
    await new Promise((resolve) => server.listen(socket, resolve));
    try {
      mkdirSync(dirname(daemonInfoFile(daemonEnv)), { recursive: true });
      writeFileSync(daemonInfoFile(daemonEnv), JSON.stringify({ socket }));
      const otherShell = {
        XDG_STATE_HOME: home,
        XDG_RUNTIME_DIR: join(home, "b"),
      };
      const client = await connectRunningDaemon(otherShell);
      assert.equal(await client.call("ping"), "pong");
      client.close();
      await assert.rejects(
        connectRunningDaemon({ XDG_STATE_HOME: join(home, "none") }),
      );
    } finally {
      server.close();
    }
  });
});
