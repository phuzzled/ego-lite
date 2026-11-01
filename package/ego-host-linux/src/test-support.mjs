/** Helpers shared by the unit tests. */
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Smallest WebSocket server: accept the upgrade, then hold the socket. */
export function webSocketServer() {
  const server = createServer();
  const sockets = new Set();
  // http.Server does not track upgraded sockets; close them with the server.
  const close = server.close.bind(server);
  server.close = (callback) => {
    for (const socket of sockets) socket.destroy();
    return close(callback);
  };
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
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

/**
 * Fake daemon socket: accepts the CDP proxy handshake, then hands every CDP
 * frame to `onFrame(text, reply)`.
 */
export function proxyServer(onFrame = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "ego-lite-proxy-"));
  const path = join(dir, "control.sock");
  const sockets = new Set();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.unref();
    socket.setEncoding("utf8");
    let mode = "control";
    socket.on("data", (chunk) => {
      if (mode === "control") {
        const { id } = JSON.parse(chunk.split("\n")[0]);
        mode = "cdp";
        socket.write(`${JSON.stringify({ id, result: "ok" })}\n`);
        return;
      }
      for (const text of chunk.split("\0").filter(Boolean)) {
        onFrame(text, (message) =>
          socket.write(`${JSON.stringify(message)}\0`),
        );
      }
    });
  });
  const close = server.close.bind(server);
  server.close = (callback) => {
    for (const socket of sockets) socket.destroy();
    return close(callback);
  };
  server.path = path;
  return new Promise((resolve) => server.listen(path, () => resolve(server)));
}
