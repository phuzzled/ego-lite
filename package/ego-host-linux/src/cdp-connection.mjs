/**
 * Minimal Chrome DevTools Protocol client over the browser WebSocket endpoint.
 * Uses the WebSocket built into Node 22+, so the host has no dependencies.
 */

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

/**
 * With NODE_USE_ENV_PROXY=1 (or --use-env-proxy) Node sends WebSocket
 * connections through HTTP_PROXY, which cannot reach the browser's loopback
 * DevTools port. Node reads NO_PROXY on every request, so exempt loopback.
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
export class CdpConnection {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();
  #closeListeners = new Set();
  #closed = false;

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#receive(event.data));
    socket.addEventListener("close", () => this.#handleClose());
    socket.addEventListener("error", () => this.#handleClose());
  }

  static connect(url, timeoutMs = 10_000) {
    bypassProxyForLoopback();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`Timed out connecting to ${url}`));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpConnection(socket));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Cannot connect to browser at ${url}`));
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
      this.#socket.send(JSON.stringify(message));
    });
  }

  /** Send an already-encoded message; replies arrive through onMessage. */
  sendRaw(payload) {
    if (this.#closed) throw new Error("Browser connection is closed");
    this.#socket.send(payload);
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
    this.#socket.close();
    this.#handleClose();
  }

  #receive(data) {
    const text = typeof data === "string" ? data : String(data);
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
