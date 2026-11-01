import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { bypassProxyForLoopback } from "./cdp-connection.mjs";
import { webSocketServer } from "./test-support.mjs";

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
