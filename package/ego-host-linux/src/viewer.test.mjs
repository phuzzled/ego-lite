import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
  Viewer,
  acceptKey,
  checkUpgrade,
  encodeFrame,
  frameParser,
  staticPath,
} from "./viewer.mjs";

/** A masked client frame, as a browser sends. */
function clientFrame(payload, opcode = 0x2) {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  const length = masked.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | length])
      : Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff]);
  return Buffer.concat([header, mask, masked]);
}

function novncDir() {
  const dir = mkdtempSync(join(tmpdir(), "ego-lite-novnc-"));
  writeFileSync(join(dir, "vnc.html"), "<html>noVNC</html>");
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "app", "ui.js"), "export {}");
  writeFileSync(join(tmpdir(), "ego-lite-outside.txt"), "secret");
  return dir;
}

describe("WebSocket frames", () => {
  it("parses masked frames split across chunks, in all length forms", () => {
    const frames = [];
    const parse = frameParser((frame) => frames.push(frame));
    const small = clientFrame(Buffer.from("hi"));
    const medium = clientFrame(Buffer.alloc(300, 7));
    const both = Buffer.concat([small, medium]);
    parse(both.subarray(0, 3));
    parse(both.subarray(3, 100));
    parse(both.subarray(100));
    assert.equal(frames[0].payload.toString(), "hi");
    assert.deepEqual(frames[1].payload, Buffer.alloc(300, 7));
  });

  it("refuses unmasked and oversized frames", () => {
    const parse = frameParser(() => {});
    assert.throws(() => parse(encodeFrame(Buffer.from("x"))), /not masked/);
    const huge = Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0x7f, 0, 0, 0]);
    assert.throws(() => frameParser(() => {})(huge), /too large/);
  });

  it("encodes server frames with 16- and 64-bit lengths", () => {
    assert.equal(encodeFrame(Buffer.alloc(10)).length, 12);
    assert.equal(encodeFrame(Buffer.alloc(1000))[1], 126);
    assert.equal(encodeFrame(Buffer.alloc(70_000))[1], 127);
  });

  it("computes the RFC 6455 accept key", () => {
    assert.equal(
      acceptKey("dGhlIHNhbXBsZSBub25jZQ=="),
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    );
  });
});

describe("checkUpgrade", () => {
  const upgrade = (url, headers) => ({
    url,
    headers: { host: "127.0.0.1:6080", ...headers },
  });

  it("needs the current token", () => {
    assert.equal(checkUpgrade(upgrade("/websockify?token=abc"), "abc"), null);
    assert.equal(checkUpgrade(upgrade("/websockify?token=abd"), "abc"), 401);
    assert.equal(checkUpgrade(upgrade("/websockify"), "abc"), 401);
    assert.equal(checkUpgrade(upgrade("/websockify?token=abc"), null), 401);
  });

  it("refuses non-loopback hosts and foreign origins", () => {
    const url = "/websockify?token=abc";
    assert.equal(
      checkUpgrade(upgrade(url, { host: "evil.test:6080" }), "abc"),
      403,
    );
    assert.equal(
      checkUpgrade(upgrade(url, { origin: "https://evil.test" }), "abc"),
      403,
    );
    assert.equal(
      checkUpgrade(upgrade(url, { origin: "http://127.0.0.1:6080" }), "abc"),
      null,
    );
    assert.equal(
      checkUpgrade(
        upgrade(url, {
          host: "localhost:7000",
          origin: "http://localhost:7000",
        }),
        "abc",
      ),
      null,
    );
  });
});

describe("staticPath", () => {
  it("serves files under the noVNC folder only", () => {
    const dir = novncDir();
    assert.match(staticPath(dir, "/vnc.html"), /vnc\.html$/);
    assert.match(staticPath(dir, "/"), /vnc\.html$/);
    assert.match(staticPath(dir, "/app/ui.js?x=1"), /ui\.js$/);
    assert.equal(staticPath(dir, "/../ego-lite-outside.txt"), null);
    assert.equal(staticPath(dir, "/%2e%2e/ego-lite-outside.txt"), null);
    assert.equal(staticPath(dir, "/app"), null);
    assert.equal(staticPath(dir, "/missing.js"), null);
  });
});

function get(port, path, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    request(
      { port, host: "127.0.0.1", path, headers: { host } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode, body }),
        );
      },
    )
      .on("error", reject)
      .end();
  });
}

/** Raw upgrade request; resolves with the socket and the status line. */
function openWebSocket(port, path) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Protocol: binary",
          "",
          "",
        ].join("\r\n"),
      );
    });
    const chunks = [];
    socket.once("data", (data) => {
      const text = data.toString("latin1");
      const end = text.indexOf("\r\n\r\n");
      chunks.push(data.subarray(end + 4));
      socket.on("data", (more) => chunks.push(more));
      resolve({
        socket,
        status: Number(text.split(" ")[1]),
        head: text.slice(0, end),
        received: () => Buffer.concat(chunks),
      });
    });
    socket.on("error", reject);
  });
}

describe("Viewer", () => {
  it("serves noVNC on loopback and bridges one WebSocket per token to x11vnc", async () => {
    const spawned = [];
    // Fake x11vnc: whatever arrives on its socket is echoed back upper-cased.
    const spawn = (command, args, options) => {
      const vnc = new PassThrough();
      const child = new EventEmitter();
      child.exitCode = null;
      child.stdio = [null, null, null, vnc];
      child.kill = () => {
        child.exitCode = 0;
        child.emit("exit", 0);
      };
      const write = vnc.write.bind(vnc);
      vnc.write = (data) => {
        vnc.push(Buffer.from(String(data).toUpperCase()));
        return true;
      };
      write(Buffer.from("RFB 003.008\n"));
      spawned.push({ command, args, options });
      return child;
    };
    const stops = [];
    const viewer = new Viewer({
      display: ":93",
      xauthority: "/run/Xauthority",
      novncDir: novncDir(),
      x11vnc: "/usr/bin/x11vnc",
      port: 0,
      spawn,
      onStop: (reason) => stops.push(reason),
    });
    await viewer.start();
    try {
      const { port } = viewer;
      assert.ok(port > 0);
      assert.equal((await get(port, "/vnc.html")).status, 200);
      assert.equal((await get(port, "/vnc.html", "evil.test")).status, 403);
      assert.equal((await get(port, "/../../etc/passwd")).status, 404);

      const token = viewer.issueToken();
      assert.match(
        viewer.url(token),
        /^http:\/\/127\.0\.0\.1:\d+\/vnc\.html\?.*path=websockify%3Ftoken%3D/,
      );
      assert.equal(
        (await openWebSocket(port, "/websockify?token=wrong")).status,
        401,
      );

      const ws = await openWebSocket(port, `/websockify?token=${token}`);
      assert.equal(ws.status, 101);
      assert.match(ws.head, /Sec-WebSocket-Protocol: binary/);
      assert.deepEqual(spawned[0].args.slice(2, 5), [
        "/usr/bin/x11vnc",
        "-inetd",
        "-display",
      ]);
      assert.equal(spawned[0].args.includes("-rfbport"), false);

      // The token is used up: a second connection is refused.
      assert.equal(
        (await openWebSocket(port, `/websockify?token=${token}`)).status,
        401,
      );

      ws.socket.write(clientFrame(Buffer.from("hello")));
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Server frames here are small and unmasked.
      const data = ws.received();
      const frames = [];
      for (let offset = 0; offset < data.length; ) {
        const length = data[offset + 1];
        frames.push(data.subarray(offset + 2, offset + 2 + length).toString());
        offset += 2 + length;
      }
      assert.deepEqual(frames, ["RFB 003.008\n", "HELLO"]);
      assert.equal(viewer.connections, 1);
      ws.socket.destroy();
    } finally {
      viewer.stop("test over");
    }
    assert.deepEqual(stops, ["test over"]);
    assert.equal(viewer.running, false);
  });
});
