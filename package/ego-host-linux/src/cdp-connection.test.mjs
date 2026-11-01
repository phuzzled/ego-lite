import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
  CdpConnection,
  bypassProxyForLoopback,
  frameReader,
} from "./cdp-connection.mjs";
import { proxyServer, webSocketServer } from "./test-support.mjs";

describe("frameReader", () => {
  it("splits NUL-framed messages across chunk borders", () => {
    const frames = [];
    const read = frameReader((frame) => frames.push(frame));
    read('{"id":1}\0{"id"');
    read(':2,"x":"');
    read('a"}\0\0{"id":3}');
    read("\0");
    assert.deepEqual(frames, ['{"id":1}', '{"id":2,"x":"a"}', '{"id":3}']);
  });
});

describe("CdpConnection over the DevTools pipe", () => {
  it("sends NUL-terminated commands and resolves replies", async () => {
    const toBrowser = new PassThrough();
    const fromBrowser = new PassThrough();
    const cdp = CdpConnection.fromPipe(fromBrowser, toBrowser);
    toBrowser.setEncoding("utf8");
    toBrowser.once("data", (chunk) => {
      assert.ok(chunk.endsWith("\0"));
      const { id, method } = JSON.parse(chunk.slice(0, -1));
      assert.equal(method, "Browser.getVersion");
      fromBrowser.write(`{"method":"Target.targetCreated","params":{}}\0`);
      // A reply larger than one stream chunk.
      fromBrowser.write(
        `{"id":${id},"result":{"big":"${"x".repeat(200_000)}"}}\0`,
      );
    });
    const events = [];
    cdp.onMessage((_text, message) => events.push(message.method));
    const result = await cdp.send("Browser.getVersion");
    assert.equal(result.big.length, 200_000);
    assert.deepEqual(events, ["Target.targetCreated"]);
    fromBrowser.end();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cdp.closed, true);
  });
});

describe("CdpConnection.connectProxy", () => {
  it("asks the daemon for the proxy, then speaks CDP on the socket", async () => {
    const server = await proxyServer((text, reply) => {
      const { id } = JSON.parse(text);
      reply({ id, result: { via: "proxy" } });
    });
    try {
      const cdp = await CdpConnection.connectProxy(server.path);
      assert.deepEqual(await cdp.send("Browser.getVersion"), { via: "proxy" });
      cdp.close();
    } finally {
      server.close();
    }
  });

  it("fails clearly when no daemon listens", async () => {
    await assert.rejects(
      CdpConnection.connectProxy("/nonexistent/ego-lite.sock", 2_000),
      /Cannot reach the ego lite daemon/,
    );
  });
});

describe("bypassProxyForLoopback", () => {
  it("sets NO_PROXY when no variable exists", () => {
    const env = {};
    bypassProxyForLoopback(env);
    assert.equal(env.NO_PROXY, "127.0.0.1,localhost,::1");
  });

  it("keeps existing entries and adds only the missing hosts", () => {
    const env = { no_proxy: "example.com, localhost" };
    bypassProxyForLoopback(env);
    assert.equal(env.no_proxy, "example.com,localhost,127.0.0.1,::1");
    assert.equal(env.NO_PROXY, undefined);
  });

  it("updates both spellings and leaves a wildcard alone", () => {
    const env = { no_proxy: "*", NO_PROXY: "intranet" };
    bypassProxyForLoopback(env);
    assert.equal(env.no_proxy, "*");
    assert.equal(env.NO_PROXY, "intranet,127.0.0.1,localhost,::1");
  });
});

describe("CdpConnection.connect", () => {
  it("reaches a loopback endpoint when Node sends traffic to a proxy", async () => {
    const server = await webSocketServer();
    const url = `ws://127.0.0.1:${server.address().port}/devtools/browser/x`;
    const module = fileURLToPath(
      new URL("./cdp-connection.mjs", import.meta.url),
    );
    const script = `
      const { CdpConnection } = await import(${JSON.stringify(module)});
      const connection = await CdpConnection.connect(${JSON.stringify(url)}, 5000);
      connection.close();
      console.log("connected");
      process.exit(0);
    `;
    try {
      const output = await new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          ["--input-type=module", "-e", script],
          {
            env: {
              ...process.env,
              NODE_USE_ENV_PROXY: "1",
              HTTP_PROXY: "http://127.0.0.1:9",
              HTTPS_PROXY: "http://127.0.0.1:9",
              NO_PROXY: "",
              no_proxy: "",
            },
            timeout: 15_000,
          },
          (error, stdout, stderr) =>
            error
              ? reject(new Error(stderr || error.message))
              : resolve(stdout),
        );
      });
      assert.match(output, /connected/);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
