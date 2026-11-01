/**
 * One browser process per persistent profile, started on demand.
 *
 * Chrome holds one profile (`--user-data-dir`) per process, so each named
 * profile gets its own browser, DevTools pipe and CdpMux. The Default
 * profile's browser starts with the daemon; the daemon stops when it dies.
 * A named profile's browser starts when a task space or a CLI round first
 * needs it, and `gc` stops it once no task space uses it. Ephemeral spaces
 * are browser contexts inside the Default browser, so they need no process.
 *
 * Target ids are unique across browsers, so the pool can tell which browser
 * owns a tab.
 */

export class BrowserPool {
  #instances = new Map();
  #starting = new Map();
  #start;
  #limits;
  #onTarget;
  #onExit;

  /**
   * @param {object} options
   * @param {(profileId: string) => Promise<{ child: object, cdp: object, mux?: object, version?: object }>} options.start
   *   launch the browser of a profile; `cdp` is a CdpConnection on its mux
   * @param {() => { maxBrowsers?: number }} [options.limits]
   * @param {(method: string, profileId: string, params: object) => void} [options.onTarget]
   *   Target.targetCreated / targetInfoChanged / targetDestroyed of any browser
   * @param {(profileId: string, lost: { targetId: string, url: string }[], expected: boolean) => void} [options.onExit]
   */
  constructor({
    start,
    limits = () => ({}),
    onTarget = () => {},
    onExit = () => {},
  }) {
    this.#start = start;
    this.#limits = limits;
    this.#onTarget = onTarget;
    this.#onExit = onExit;
  }

  /** Running browsers, by profile id. */
  running() {
    return [...this.#instances.keys()];
  }

  get(profileId) {
    return this.#instances.get(profileId) ?? null;
  }

  /** The browser of a profile, started when needed. */
  async ensure(profileId) {
    const running = this.#instances.get(profileId);
    if (running) return running;
    const starting = this.#starting.get(profileId);
    if (starting) return starting;
    const max = this.#limits().maxBrowsers ?? 0;
    const count = this.#instances.size + this.#starting.size;
    if (max > 0 && count >= max) {
      const error = new Error(
        `Resource limit reached: ${count} browsers are running, one per profile in use (limit ${max}). Finish task spaces of other profiles, or run \`ego-browser gc\`.`,
      );
      error.error_code = "EGO_RESOURCE_LIMIT";
      throw error;
    }
    const promise = this.#launch(profileId).finally(() =>
      this.#starting.delete(profileId),
    );
    this.#starting.set(profileId, promise);
    return promise;
  }

  async #launch(profileId) {
    const instance = await this.#start(profileId);
    instance.profileId = profileId;
    instance.targets = new Map();
    instance.stopping = false;
    this.#instances.set(profileId, instance);
    instance.cdp.onMessage((_text, message) =>
      this.#targetEvent(instance, message),
    );
    instance.child.on("exit", () => this.#exited(instance));
    try {
      await instance.cdp.send("Target.setDiscoverTargets", { discover: true });
      const { targetInfos } = await instance.cdp.send("Target.getTargets");
      for (const info of targetInfos) instance.targets.set(info.targetId, info);
    } catch (error) {
      this.#instances.delete(profileId);
      instance.stopping = true;
      instance.child.kill?.("SIGKILL");
      throw error;
    }
    return instance;
  }

  #targetEvent(instance, message) {
    const { method, params } = message;
    if (
      method === "Target.targetCreated" ||
      method === "Target.targetInfoChanged"
    ) {
      instance.targets.set(params.targetInfo.targetId, params.targetInfo);
    } else if (method === "Target.targetDestroyed") {
      instance.targets.delete(params.targetId);
    } else {
      return;
    }
    this.#onTarget(method, instance.profileId, params);
  }

  #exited(instance) {
    if (this.#instances.get(instance.profileId) !== instance) return;
    this.#instances.delete(instance.profileId);
    instance.mux?.close?.();
    instance.cdp.close?.();
    const lost = [...instance.targets.values()]
      .filter((info) => info.type === "page")
      .map((info) => ({ targetId: info.targetId, url: info.url ?? "" }));
    this.#onExit(instance.profileId, lost, instance.stopping);
  }

  /** Info of a target in any browser. */
  targetInfo(targetId) {
    for (const instance of this.#instances.values()) {
      const info = instance.targets.get(targetId);
      if (info) return info;
    }
    return undefined;
  }

  /** The browser that holds a target, or null. */
  ownerOf(targetId) {
    for (const instance of this.#instances.values()) {
      if (instance.targets.has(targetId)) return instance;
    }
    return null;
  }

  /** Process ids of the running browsers, for the memory limit. */
  pids() {
    return [...this.#instances.values()]
      .map((instance) => instance.child.pid)
      .filter(Number.isInteger);
  }

  /** Clients (CLI rounds) attached to a profile's browser right now. */
  clientCount(profileId) {
    return this.#instances.get(profileId)?.mux?.clientCount ?? 0;
  }

  /**
   * Close a browser the polite way first, so it writes its cookies to disk:
   * Browser.close, then SIGTERM, then SIGKILL.
   */
  async stop(profileId, timeoutMs = 5_000) {
    const instance = this.#instances.get(profileId);
    if (!instance) return false;
    instance.stopping = true;
    const exited = new Promise((resolve) => {
      if (
        instance.child.exitCode !== null &&
        instance.child.exitCode !== undefined
      ) {
        resolve();
      } else {
        instance.child.once("exit", resolve);
      }
    });
    const wait = (ms) =>
      Promise.race([
        exited.then(() => true),
        new Promise((resolve) =>
          setTimeout(() => resolve(false), ms).unref?.(),
        ),
      ]);
    instance.cdp
      .send("Browser.close", {}, undefined, timeoutMs)
      .catch(() => {});
    if (await wait(timeoutMs)) return true;
    instance.child.kill?.("SIGTERM");
    if (await wait(timeoutMs)) return true;
    instance.child.kill?.("SIGKILL");
    await wait(1_000);
    return true;
  }
}
