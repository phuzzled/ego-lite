/**
 * Minimal Chrome DevTools Protocol client. It talks to the browser over one of
 * three transports, all without dependencies:
 *
 * - the DevTools pipe (file descriptors 3 and 4, NUL-framed JSON), used by
 *   the daemon;
 * - the daemon's CDP proxy on its private Unix socket, used by the CLI;
 * - a WebSocket endpoint (opt-in port mode, EGO_LITE_DEVTOOLS=port).
 */
import { connect as connectSocket } from "node:net";

import { encode, lineReader } from "./control-channel.mjs";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

/**
 * With NODE_USE_ENV_PROXY=1 (or --use-env-proxy) Node sends WebSocket
 * connections through HTTP_PROXY, which cannot reach the browser's loopback
 * DevTools port. Node reads NO_PROXY on every request, so exempt loopback.
 * Only port mode needs this; the pipe and the Unix socket never use a proxy.
 */
export function bypassProxyForLoopback(env = process.env) {
  const keys = ["no_proxy", "NO_PROXY"].filter((key) => env[key] !== undefined);
  if (keys.length === 0) keys.push("NO_PROXY");
  for (const key of keys) {
    const entries = (env[key] || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.includes("*")) continue;
    const missing = LOOPBACK_HOSTS.filter((host) => !entries.includes(host));
    if (missing.length > 0) env[key] = [...entries, ...missing].join(",");
  }
}

/**
 * Split a text stream on a delimiter. Chunks are kept in a list until the
 * delimiter arrives, so a multi-megabyte snapshot reply is joined once.
 */
export function frameReader(onFrame, delimiter = "\0") {
  let parts = [];
  return (chunk) => {
    let start = 0;
    let index;
    while ((index = chunk.indexOf(delimiter, start)) >= 0) {
      parts.push(chunk.slice(start, index));
      const frame = parts.join("");
      parts = [];
      start = index + delimiter.length;
      if (frame.length > 0) onFrame(frame);
    }
    if (start < chunk.length) parts.push(chunk.slice(start));
  };
}

/**
 * Transport over a pair of streams with NUL-terminated messages: the
 * DevTools pipe, or the daemon's proxy socket (one duplex stream twice).
 */
export function streamTransport(readable, writable) {
  const messageListeners = new Set();
  const closeListeners = new Set();
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener();
  };
  readable.setEncoding("utf8");
  readable.on(
    "data",
    frameReader((text) => {
      for (const listener of messageListeners) listener(text);
    }),
  );
  readable.on("close", finish);
  readable.on("end", finish);
  readable.on("error", finish);
  writable.on("error", finish);
  writable.on("close", finish);
  return {
    send(text) {
      if (!closed) writable.write(`${text}\0`);
    },
    close() {
      if (closed) return;
      readable.destroy?.();
      if (writable !== readable) writable.destroy?.();
      finish();
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onClose: (listener) => closeListeners.add(listener),
  };
}

/** Open a WebSocket to a DevTools endpoint and wrap it as a transport. */
export function openWebSocket(url, timeoutMs = 10_000) {
  bypassProxyForLoopback();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out connecting to ${url}`));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(webSocketTransport(socket));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`Cannot connect to browser at ${url}`));
    });
  });
}

function webSocketTransport(socket) {
  const messageListeners = new Set();
  const closeListeners = new Set();
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener();
  };
  socket.addEventListener("message", (event) => {
    const text =
      typeof event.data === "string" ? event.data : String(event.data);
    for (const listener of messageListeners) listener(text);
  });
  socket.addEventListener("close", finish);
  socket.addEventListener("error", finish);
  return {
    send: (text) => socket.send(text),
    close() {
      socket.close();
      finish();
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onClose: (listener) => closeListeners.add(listener),
  };
}

export class CdpConnection {
  #transport;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();
  #closeListeners = new Set();
  #closed = false;

  constructor(transport) {
    this.#transport = transport;
    transport.onMessage((text) => this.#receive(text));
    transport.onClose(() => this.#handleClose());
  }

  /** Port mode: the browser's WebSocket endpoint. */
  static async connect(url, timeoutMs = 10_000) {
    return new CdpConnection(await openWebSocket(url, timeoutMs));
  }

  /** The DevTools pipe of a browser started with --remote-debugging-pipe. */
  static fromPipe(readable, writable) {
    return new CdpConnection(streamTransport(readable, writable));
  }

  /**
   * The daemon's CDP proxy. The client asks for it on the control socket
   * ({"method":"cdpProxy"}); after the reply the socket carries CDP frames.
   * `params.browser` picks the browser of a profile (Default when omitted).
   */
  static connectProxy(socketPath, timeoutMs = 10_000, params = {}) {
    return new Promise((resolve, reject) => {
      const socket = connectSocket(socketPath);
      const fail = (error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error(`Timed out connecting to ${socketPath}`)),
        timeoutMs,
      );
      socket.once("error", (error) =>
        fail(new Error(`Cannot reach the ego lite daemon: ${error.message}`)),
      );
      socket.once("connect", () => {
        socket.setEncoding("utf8");
        const onData = lineReader((reply) => {
          socket.off("data", onData);
          clearTimeout(timer);
          if (reply.error !== undefined) {
            socket.destroy();
            reject(new Error(String(reply.error)));
            return;
          }
          socket.removeAllListeners("error");
          resolve(new CdpConnection(streamTransport(socket, socket)));
        });
        socket.on("data", onData);
        socket.write(encode({ id: 1, method: "cdpProxy", params }));
      });
    });
  }

  get closed() {
    return this.#closed;
  }

  /** Send one command and resolve its `result`; reject on a protocol error. */
  send(method, params = {}, sessionId = undefined, timeoutMs = 30_000) {
    if (this.#closed) {
      return Promise.reject(new Error("Browser connection is closed"));
    }
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      this.#transport.send(JSON.stringify(message));
    });
  }

  /** Send an already-encoded message; replies arrive through onMessage. */
  sendRaw(payload) {
    if (this.#closed) throw new Error("Browser connection is closed");
    this.#transport.send(payload);
  }

  /** Listen to every incoming message as raw text. Returns an unsubscribe. */
  onMessage(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onClose(listener) {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close() {
    if (this.#closed) return;
    this.#transport.close();
    this.#handleClose();
  }

  #receive(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const pending =
      message.id !== undefined ? this.#pending.get(message.id) : undefined;
    if (pending) {
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(`CDP ${pending.method}: ${message.error.message}`),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    for (const listener of this.#listeners) listener(text, message);
  }

  #handleClose() {
    if (this.#closed) return;
    this.#closed = true;
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(new Error("Browser connection closed"));
    }
    this.#pending.clear();
    for (const listener of this.#closeListeners) listener();
  }
}
