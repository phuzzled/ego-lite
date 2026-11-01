/**
 * Browser viewer for hand-off on a server: noVNC in the user's own browser,
 * through an SSH tunnel, onto the daemon's virtual display.
 *
 *   user's browser --ssh -L--> 127.0.0.1:<port> (this server: noVNC files and
 *   one WebSocket) --stdio socket--> x11vnc -inetd --> Xvfb display
 *
 * Security:
 * - the HTTP server binds 127.0.0.1 only; nothing listens on a public address;
 * - x11vnc runs per connection in inetd mode on a socket pair, so it has no
 *   listening port at all;
 * - the WebSocket needs a random one-time token: the first connection uses it
 *   up, and `ego-browser view` issues a new one;
 * - Host and Origin must be loopback names, against DNS rebinding and
 *   cross-site WebSocket use;
 * - the viewer stops after a timeout or when the hand-off ends.
 */
import { spawn as spawnProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, sep } from "node:path";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const NOVNC_DIRS = ["/usr/share/novnc", "/usr/share/webapps/novnc"];
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
};
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function findNoVnc(env = process.env, exists = existsSync) {
  const dirs = env.EGO_LITE_NOVNC_DIR ? [env.EGO_LITE_NOVNC_DIR] : NOVNC_DIRS;
  return dirs.find((dir) => exists(join(dir, "vnc.html"))) ?? null;
}

export function acceptKey(key) {
  return createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

/** One unmasked server frame. */
export function encodeFrame(payload, opcode = 0x2) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Parse client frames. Clients must mask; oversized frames are refused.
 * `onFrame({ opcode, payload })` gets each frame, continuations included.
 */
export function frameParser(onFrame) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME_BYTES)) throw new Error("frame too large");
        length = Number(big);
        offset = 10;
      }
      if (!masked) throw new Error("client frame not masked");
      if (length > MAX_FRAME_BYTES) throw new Error("frame too large");
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(
        buffer.subarray(offset + 4, offset + 4 + length),
      );
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(offset + 4 + length);
      onFrame({ opcode, payload });
    }
  };
}

function hostName(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(value);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Null when the upgrade may go on, else the HTTP status to refuse with.
 * The token must match and be unused; Host and Origin must be loopback.
 */
export function checkUpgrade(request, token) {
  if (!LOOPBACK_NAMES.has(hostName(request.headers.host))) return 403;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return 403;
    }
    if (parsed.host !== request.headers.host) return 403;
  }
  const query = new URL(request.url, "http://localhost").searchParams;
  const offered = query.get("token") || "";
  if (!token || !sameSecret(offered, token)) return 401;
  return null;
}

function sameSecret(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** File under `root` for a URL path, or null (no traversal, files only). */
export function staticPath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(new URL(urlPath, "http://localhost").pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const relative = decoded === "/" ? "vnc.html" : decoded.replace(/^\/+/, "");
  const base = realpathSync(root);
  let path;
  try {
    path = realpathSync(join(base, relative));
  } catch {
    return null;
  }
  if (path !== base && !path.startsWith(`${base}${sep}`)) return null;
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

export class Viewer {
  #options;
  #server = null;
  #token = null;
  #connections = new Set();
  #timer = null;
  #onStop;
  spaceId;
  expiresAt = 0;

  /**
   * @param {object} options
   * @param {string} options.display      X display, as ":93"
   * @param {string} options.xauthority   cookie file of that display
   * @param {string} options.novncDir     noVNC web files
   * @param {string} options.x11vnc       x11vnc binary
   * @param {number} [options.port]
   * @param {number} [options.timeoutMs]
   * @param {(reason: string) => void} [options.onStop]
   */
  constructor(options) {
    this.#options = { port: 6080, timeoutMs: 30 * 60_000, ...options };
    this.#onStop = options.onStop ?? (() => {});
  }

  get running() {
    return this.#server !== null;
  }

  get port() {
    return this.#options.port;
  }

  get connections() {
    return this.#connections.size;
  }

  async start() {
    if (this.#server) return;
    const server = createServer((request, response) =>
      this.#serveFile(request, response),
    );
    server.on("upgrade", (request, socket) => this.#upgrade(request, socket));
    await new Promise((resolve, reject) => {
      server.once("error", (error) => {
        reject(
          error.code === "EADDRINUSE"
            ? Object.assign(
                new Error(
                  `Port ${this.#options.port} on 127.0.0.1 is in use. Set "viewerPort" in ~/.config/ego-lite/config.json.`,
                ),
                { error_code: "EGO_VIEWER_UNAVAILABLE" },
              )
            : error,
        );
      });
      server.listen(this.#options.port, "127.0.0.1", resolve);
    });
    this.#server = server;
    this.#options.port = server.address().port;
    this.#restartTimer();
  }

  /** A fresh one-time token; any earlier unused token stops working. */
  issueToken() {
    this.#token = randomBytes(24).toString("base64url");
    this.#restartTimer();
    return this.#token;
  }

  url(token) {
    const path = encodeURIComponent(`websockify?token=${token}`);
    return `http://127.0.0.1:${this.#options.port}/vnc.html?autoconnect=1&resize=scale&reconnect=0&path=${path}`;
  }

  stop(reason = "stopped") {
    if (!this.#server) return;
    clearTimeout(this.#timer);
    this.#server.close();
    this.#server = null;
    this.#token = null;
    for (const connection of this.#connections) connection.close();
    this.#connections.clear();
    this.#onStop(reason);
  }

  #restartTimer() {
    clearTimeout(this.#timer);
    this.expiresAt = Date.now() + this.#options.timeoutMs;
    this.#timer = setTimeout(
      () => this.stop("timeout"),
      this.#options.timeoutMs,
    );
    this.#timer.unref?.();
  }

  #serveFile(request, response) {
    const refuse = (status) => {
      response.writeHead(status, { "content-type": "text/plain" });
      response.end(`${status}\n`);
    };
    if (!LOOPBACK_NAMES.has(hostName(request.headers.host))) return refuse(403);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return refuse(405);
    }
    const path = staticPath(this.#options.novncDir, request.url);
    if (!path) return refuse(404);
    response.writeHead(200, {
      "content-type":
        MIME_TYPES[extname(path).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    response.end(request.method === "HEAD" ? undefined : readFileSync(path));
  }

  #upgrade(request, socket) {
    const status = checkUpgrade(request, this.#token);
    const key = request.headers["sec-websocket-key"];
    if (status || !key) {
      socket.end(
        `HTTP/1.1 ${status || 400} Refused\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    // One-time: the token is used up by this connection.
    this.#token = null;
    const protocols = String(request.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((value) => value.trim());
    const protocol = protocols.includes("binary") ? "binary" : null;
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
        "",
        "",
      ].join("\r\n"),
    );
    this.#bridge(socket);
  }

  /** Pipe one WebSocket to a new x11vnc whose stdin and stdout are a socket. */
  #bridge(socket) {
    const { x11vnc, display, xauthority } = this.#options;
    const spawn = this.#options.spawn ?? spawnProcess;
    // fd 3 is a socket pair end; x11vnc -inetd reads and writes fd 0.
    const vnc = spawn(
      "/bin/sh",
      [
        "-c",
        'exec "$0" "$@" <&3 >&3 3>&-',
        x11vnc,
        "-inetd",
        "-display",
        display,
        "-auth",
        xauthority,
        "-nopw",
        "-quiet",
        "-noxdamage",
        "-nowf",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe"] },
    );
    const stream = vnc.stdio[3];
    let closed = false;
    const connection = {
      close: () => {
        if (closed) return;
        closed = true;
        this.#connections.delete(connection);
        if (!socket.destroyed) {
          socket.write(encodeFrame(Buffer.alloc(0), 0x8));
          socket.destroy();
        }
        stream.destroy();
        if (vnc.exitCode === null) vnc.kill("SIGTERM");
      },
    };
    this.#connections.add(connection);
    stream.on("data", (data) => {
      if (!socket.destroyed) socket.write(encodeFrame(data));
    });
    stream.on("close", connection.close);
    stream.on("error", connection.close);
    vnc.on("exit", connection.close);
    socket.on("close", connection.close);
    socket.on("error", connection.close);
    const parse = frameParser(({ opcode, payload }) => {
      if (opcode === 0x8) connection.close();
      else if (opcode === 0x9) socket.write(encodeFrame(payload, 0xa));
      else if (opcode <= 0x2 && payload.length > 0) stream.write(payload);
    });
    socket.on("data", (chunk) => {
      try {
        parse(chunk);
      } catch {
        connection.close();
      }
    });
  }
}
