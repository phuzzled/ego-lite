/**
 * Share one DevTools connection (the browser pipe) between many clients.
 *
 * Chrome keeps state per DevTools connection: sessions, discovery, download
 * events. With --remote-debugging-pipe there is only one connection, so the
 * daemon gives each client a virtual one that behaves the same way:
 *
 * - command ids are rewritten, so clients may reuse ids;
 * - a session belongs to the client that attached it; its events go only to
 *   that client, and other clients cannot send to it;
 * - Target.setDiscoverTargets is answered here (the daemon keeps discovery on
 *   for everyone), with targetCreated for existing targets as Chrome does;
 * - when a client leaves, its sessions are detached, as when a WebSocket
 *   closes, so no interception or pause outlives the round that set it.
 */
import { CdpConnection, frameReader } from "./cdp-connection.mjs";

const SESSION_NOT_FOUND = {
  code: -32001,
  message: "Session with given id not found.",
};
const TARGET_EVENTS = new Set([
  "Target.targetCreated",
  "Target.targetInfoChanged",
  "Target.targetDestroyed",
  "Target.targetCrashed",
]);

export class CdpMux {
  #upstream;
  #nextId = 1;
  #requests = new Map();
  #clients = new Set();
  #sessions = new Map();
  #pendingAttach = [];
  #targets = new Map();
  #onCommand;
  #closed = false;

  /**
   * @param {{ send(text: string): void, onMessage(l: (text: string) => void): void, onClose(l: () => void): void }} upstream
   * @param {{ onCommand?: (client: object, message: object) => void }} [options]
   */
  constructor(upstream, { onCommand = () => {} } = {}) {
    this.#upstream = upstream;
    this.#onCommand = onCommand;
    upstream.onMessage((text) => this.#fromUpstream(text));
    upstream.onClose(() => this.close());
  }

  /** Turn on target discovery upstream, once for every client. */
  start(timeoutMs = 30_000) {
    return this.#internal(
      "Target.setDiscoverTargets",
      { discover: true },
      timeoutMs,
    );
  }

  get clientCount() {
    return [...this.#clients].filter((client) => !client.local).length;
  }

  /** A CdpConnection for the daemon's own use, routed like any client. */
  localConnection() {
    const messageListeners = new Set();
    const closeListeners = new Set();
    const client = this.#addClient({
      local: true,
      deliver: (text) =>
        queueMicrotask(() => {
          for (const listener of messageListeners) listener(text);
        }),
      end: () => {
        for (const listener of closeListeners) listener();
      },
    });
    return new CdpConnection({
      send: (text) => this.#fromClient(client, text),
      close: () => this.#removeClient(client),
      onMessage: (listener) => messageListeners.add(listener),
      onClose: (listener) => closeListeners.add(listener),
    });
  }

  /** Serve a client on a duplex stream with NUL-framed messages. */
  attachStream(socket, meta = {}) {
    const client = this.#addClient({
      ...meta,
      deliver: (text) => {
        if (!socket.destroyed) socket.write(`${text}\0`);
      },
      end: () => socket.destroy(),
    });
    socket.setEncoding("utf8");
    socket.on(
      "data",
      frameReader((text) => this.#fromClient(client, text)),
    );
    const leave = () => this.#removeClient(client);
    socket.on("close", leave);
    socket.on("error", leave);
    return client;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const client of [...this.#clients]) this.#removeClient(client);
  }

  #addClient(fields) {
    const client = {
      discover: false,
      downloadEvents: false,
      autoAttach: false,
      closed: false,
      ...fields,
    };
    if (this.#closed) {
      queueMicrotask(() => client.end());
      client.closed = true;
      return client;
    }
    this.#clients.add(client);
    return client;
  }

  #removeClient(client) {
    if (client.closed) return;
    client.closed = true;
    this.#clients.delete(client);
    this.#pendingAttach = this.#pendingAttach.filter(
      (entry) => entry.client !== client,
    );
    for (const [sessionId, owner] of this.#sessions) {
      if (owner !== client) continue;
      this.#sessions.delete(sessionId);
      // A closed WebSocket detaches its sessions; do the same here.
      if (!this.#closed) {
        this.#internal("Target.detachFromTarget", { sessionId }).catch(
          () => {},
        );
      }
    }
    client.end();
  }

  #reply(client, message) {
    if (!client.closed) client.deliver(JSON.stringify(message));
  }

  #fromClient(client, text) {
    if (client.closed || this.#closed) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || typeof message !== "object" || message.id === undefined) {
      return;
    }
    const { id, method, sessionId } = message;
    const params = message.params || {};
    this.#onCommand(client, message);

    if (sessionId !== undefined && this.#sessions.get(sessionId) !== client) {
      this.#reply(client, { id, error: SESSION_NOT_FOUND, sessionId });
      return;
    }
    if (sessionId === undefined) {
      if (method === "Target.setDiscoverTargets") {
        client.discover = params.discover === true;
        if (client.discover) {
          for (const targetInfo of this.#targets.values()) {
            this.#reply(client, {
              method: "Target.targetCreated",
              params: { targetInfo },
            });
          }
        }
        this.#reply(client, { id, result: {} });
        return;
      }
      if (
        method === "Target.detachFromTarget" &&
        params.sessionId !== undefined &&
        this.#sessions.get(params.sessionId) !== client
      ) {
        this.#reply(client, { id, error: SESSION_NOT_FOUND });
        return;
      }
      if (method === "Target.setAutoAttach") {
        client.autoAttach = params.autoAttach === true;
      }
      if (method === "Browser.setDownloadBehavior") {
        client.downloadEvents = params.eventsEnabled === true;
      }
    }

    const upstreamId = this.#nextId++;
    this.#requests.set(upstreamId, { client, id, method });
    if (method === "Target.attachToTarget" && sessionId === undefined) {
      this.#pendingAttach.push({
        client,
        targetId: params.targetId,
        upstreamId,
      });
    }
    message.id = upstreamId;
    this.#upstream.send(JSON.stringify(message));
  }

  #internal(method, params, timeoutMs = 10_000) {
    if (this.#closed) return Promise.reject(new Error("browser closed"));
    const upstreamId = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#requests.delete(upstreamId);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.#requests.set(upstreamId, {
        internal: (message) => {
          clearTimeout(timer);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result ?? {});
        },
      });
      this.#upstream.send(JSON.stringify({ id: upstreamId, method, params }));
    });
  }

  #fromUpstream(text) {
    // Replies are most of the traffic and can be megabytes (snapshots).
    // Chrome writes "id" first, so route them without parsing the body.
    const head = /^\{"id":(\d+)/.exec(text);
    if (head) {
      const request = this.#requests.get(Number(head[1]));
      if (request && !request.internal && !needsResult(request.method)) {
        this.#requests.delete(Number(head[1]));
        if (!request.client.closed) {
          request.client.deliver(
            `{"id":${JSON.stringify(request.id)}${text.slice(head[0].length)}`,
          );
        }
        return;
      }
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined) this.#response(message);
    else if (message.method) this.#event(message, text);
  }

  #response(message) {
    const request = this.#requests.get(message.id);
    if (!request) return;
    this.#requests.delete(message.id);
    if (request.internal) {
      request.internal(message);
      return;
    }
    const { client } = request;
    const attached = message.result?.sessionId;
    if (needsResult(request.method)) {
      this.#pendingAttach = this.#pendingAttach.filter(
        (entry) => entry.upstreamId !== message.id,
      );
      if (attached) {
        if (client.closed) {
          this.#internal("Target.detachFromTarget", {
            sessionId: attached,
          }).catch(() => {});
          return;
        }
        this.#sessions.set(attached, client);
      }
    }
    message.id = request.id;
    this.#reply(client, message);
  }

  #event(message, text) {
    const { method, sessionId } = message;
    const params = message.params || {};
    if (sessionId !== undefined) {
      const owner = this.#sessions.get(sessionId);
      if (!owner) return;
      if (method === "Target.attachedToTarget" && params.sessionId) {
        this.#sessions.set(params.sessionId, owner);
      }
      if (method === "Target.detachedFromTarget" && params.sessionId) {
        this.#sessions.delete(params.sessionId);
      }
      owner.deliver(text);
      return;
    }

    if (TARGET_EVENTS.has(method)) {
      const info = params.targetInfo;
      if (method === "Target.targetDestroyed") {
        this.#targets.delete(params.targetId);
      } else if (info && method !== "Target.targetCrashed") {
        this.#targets.set(info.targetId, info);
      }
      for (const client of this.#clients) {
        if (client.discover) client.deliver(text);
      }
      return;
    }
    if (method === "Target.attachedToTarget") {
      const targetId = params.targetInfo?.targetId;
      const index = this.#pendingAttach.findIndex(
        (entry) => entry.targetId === targetId,
      );
      let owner;
      if (index >= 0) {
        owner = this.#pendingAttach[index].client;
        this.#pendingAttach.splice(index, 1);
      } else {
        owner = [...this.#clients].find((client) => client.autoAttach);
      }
      if (!owner) {
        this.#internal("Target.detachFromTarget", {
          sessionId: params.sessionId,
        }).catch(() => {});
        return;
      }
      this.#sessions.set(params.sessionId, owner);
      owner.deliver(text);
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const owner = this.#sessions.get(params.sessionId);
      this.#sessions.delete(params.sessionId);
      if (owner) owner.deliver(text);
      return;
    }
    if (method.startsWith("Browser.download")) {
      for (const client of this.#clients) {
        if (client.downloadEvents) client.deliver(text);
      }
      return;
    }
    for (const client of this.#clients) client.deliver(text);
  }
}

function needsResult(method) {
  return (
    method === "Target.attachToTarget" ||
    method === "Target.attachToBrowserTarget"
  );
}
