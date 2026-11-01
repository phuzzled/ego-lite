/** Helpers shared by the unit tests. */
import { createHash } from "node:crypto";
import { createServer } from "node:http";

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
