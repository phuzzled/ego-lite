/**
 * The raw CDP channel of one CLI round (`ego.sendCDPMessage`), across the
 * browsers of several profiles.
 *
 * Each named profile runs in its own browser, so a round that uses task
 * spaces of two profiles talks to two browsers. The SDK sees one channel; the
 * router picks the browser of each command:
 *
 * - a command on a session goes to the browser that created the session;
 * - a command that names a tab (`params.targetId`) goes to the browser that
 *   holds the tab;
 * - anything else goes to the browser of the selected task space.
 *
 * Replies and events of all browsers come back through one listener. With
 * only the Default browser in use, commands are not parsed at all.
 */
export class CdpRouter {
  #connect;
  #default;
  #entries = new Map();
  #sessions = new Map();
  #attaches = new Set();
  #listener = () => {};
  #closed = false;

  /**
   * @param {object} options
   * @param {(browser: string) => Promise<object>} options.connect
   *   a CdpConnection to the browser of a profile
   * @param {object} options.initial  the open connection to the default browser
   * @param {string} [options.defaultBrowser]
   */
  constructor({ connect, initial, defaultBrowser = "Default" }) {
    this.#connect = connect;
    this.#default = defaultBrowser;
    const entry = { connection: initial, queue: [] };
    this.#entries.set(defaultBrowser, entry);
    initial.onMessage((text) => this.#receive(defaultBrowser, text));
  }

  /** True when the default browser's connection is gone. */
  get closed() {
    return this.#closed || this.#entries.get(this.#default).connection.closed;
  }

  /** Browsers this round has a connection to (or is opening one to). */
  get browsers() {
    return [...this.#entries.keys()];
  }

  onMessage(listener) {
    this.#listener = listener;
  }

  /** Start connecting to a browser before the first command needs it. */
  prepare(browser) {
    if (!this.#closed) this.#entry(browser);
  }

  /**
   * Send one encoded command.
   * @param {string} text
   * @param {string} selected  browser of the selected task space
   * @param {(targetId: string) => string | undefined} [browserOfTarget]
   */
  send(text, selected, browserOfTarget = () => undefined) {
    let browser = selected;
    if (this.#entries.size > 1 || selected !== this.#default) {
      let message = null;
      try {
        message = JSON.parse(text);
      } catch {
        // Let the browser answer a malformed command.
      }
      if (message && typeof message === "object") {
        const params = message.params || {};
        const session =
          message.sessionId ??
          (message.method === "Target.detachFromTarget"
            ? params.sessionId
            : undefined);
        if (session !== undefined) {
          // Sessions opened before a second browser joined are the default's.
          browser = this.#sessions.get(session) ?? this.#default;
        } else if (typeof params.targetId === "string") {
          browser = browserOfTarget(params.targetId) ?? selected;
        }
        if (
          message.sessionId === undefined &&
          message.method === "Target.attachToTarget"
        ) {
          this.#attaches.add(`${browser}\0${message.id}`);
        }
      }
    }
    const entry = this.#entry(browser);
    if (entry.connection) entry.connection.sendRaw(text);
    else entry.queue.push(text);
  }

  close() {
    this.#closed = true;
    for (const entry of this.#entries.values()) entry.connection?.close();
  }

  #entry(browser) {
    let entry = this.#entries.get(browser);
    if (entry) return entry;
    entry = { connection: null, queue: [] };
    this.#entries.set(browser, entry);
    this.#connect(browser).then(
      (connection) => {
        if (this.#closed) {
          connection.close();
          return;
        }
        entry.connection = connection;
        connection.onMessage((text) => this.#receive(browser, text));
        connection.onClose(() => {
          // The next command to this browser connects again.
          if (this.#entries.get(browser) === entry) {
            this.#entries.delete(browser);
          }
        });
        for (const text of entry.queue) connection.sendRaw(text);
        entry.queue = [];
      },
      (error) => {
        this.#entries.delete(browser);
        for (const text of entry.queue) this.#fail(text, browser, error);
        entry.queue = [];
      },
    );
    return entry;
  }

  /** Answer a command that could not be sent, so its caller does not hang. */
  #fail(text, browser, error) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message?.id === undefined) return;
    const reply = {
      id: message.id,
      error: {
        code: -32000,
        message: `Cannot reach the browser of profile ${browser}: ${error?.message || error}`,
      },
    };
    if (message.sessionId !== undefined) reply.sessionId = message.sessionId;
    queueMicrotask(() => this.#listener(JSON.stringify(reply)));
  }

  #receive(browser, text) {
    if (text.length < 65_536) this.#track(browser, text);
    this.#listener(text);
  }

  /** Learn which browser owns each session. */
  #track(browser, text) {
    if (this.#attaches.size > 0) {
      const reply = /^\{"id":(\d+),"(result|error)"/.exec(text);
      if (reply && this.#attaches.delete(`${browser}\0${reply[1]}`)) {
        const session = /^\{"id":\d+,"result":\{"sessionId":"([^"]+)"/.exec(
          text,
        );
        if (session) this.#sessions.set(session[1], browser);
        return;
      }
    }
    if (
      text.includes('"Target.attachedToTarget"') ||
      text.includes('"Target.detachedFromTarget"')
    ) {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      const session = message.params?.sessionId;
      if (!session) return;
      if (message.method === "Target.attachedToTarget") {
        this.#sessions.set(session, browser);
      } else if (message.method === "Target.detachedFromTarget") {
        this.#sessions.delete(session);
      }
    }
  }
}
