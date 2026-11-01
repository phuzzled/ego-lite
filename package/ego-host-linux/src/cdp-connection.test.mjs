import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { bypassProxyForLoopback } from "./cdp-connection.mjs";

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

/** Smallest WebSocket server: accept the upgrade, then hold the socket. */
function webSocketServer() {
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    socket.unref();
    const accept = createHash("sha1")
      .update(
        `${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

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
