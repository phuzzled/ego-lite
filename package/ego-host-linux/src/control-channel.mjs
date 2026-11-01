/**
 * JSON-lines RPC between the CLI and the daemon over a Unix socket.
 *
 *   request  {"id":1,"method":"listSpaces","params":{}}
 *   response {"id":1,"result":...} or {"id":1,"error":"..."}
 *   push     {"event":"spaces","data":[...]}
 */
import { connect } from "node:net";

export function encode(message) {
  return `${JSON.stringify(message)}\n`;
}

/** Split a stream into JSON messages. */
export function lineReader(onMessage) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      onMessage(message);
    }
  };
}

export class ControlClient {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #eventListeners = new Set();
  #closed = false;

  constructor(socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on(
      "data",
      lineReader((message) => this.#receive(message)),
    );
    socket.on("close", () => this.#handleClose());
    socket.on("error", () => this.#handleClose());
  }

  static connect(path, timeoutMs = 2_000) {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting to ${path}`));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(new ControlClient(socket));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  get closed() {
    return this.#closed;
  }

  call(method, params = {}, timeoutMs = 60_000) {
    if (this.#closed) {
      return Promise.reject(new Error("ego lite daemon is not connected"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`ego lite daemon call ${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.write(encode({ id, method, params }));
    });
  }

  onEvent(listener) {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  close() {
    this.#socket.end();
    this.#socket.destroy();
    this.#handleClose();
  }

  #receive(message) {
    if (message.event) {
      for (const listener of this.#eventListeners) {
        listener(message.event, message.data);
      }
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  #handleClose() {
    if (this.#closed) return;
    this.#closed = true;
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(new Error("ego lite daemon connection closed"));
    }
    this.#pending.clear();
  }
}
