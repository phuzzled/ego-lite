import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG, configFile, loadConfig } from "./config.mjs";

const env = { XDG_CONFIG_HOME: "/cfg" };
const reading = (text) => (path) => {
  assert.equal(path, "/cfg/ego-lite/config.json");
  return text;
};

describe("loadConfig", () => {
  it("uses the defaults without a file", () => {
    const missing = () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    const { config, warnings } = loadConfig(env, missing);
    assert.deepEqual(config, { ...DEFAULT_CONFIG });
    assert.deepEqual(warnings, []);
    assert.equal(configFile(env), "/cfg/ego-lite/config.json");
  });

  it("reads limits, and 0 turns a limit off", () => {
    const { config, warnings } = loadConfig(
      env,
      reading('{"maxTaskSpaces": 2, "maxRssMb": 0, "viewerPort": 7000}'),
    );
    assert.equal(config.maxTaskSpaces, 2);
    assert.equal(config.maxRssMb, 0);
    assert.equal(config.viewerPort, 7000);
    assert.equal(config.maxPagesPerSpace, DEFAULT_CONFIG.maxPagesPerSpace);
    assert.deepEqual(warnings, []);
  });

  it("warns about bad values and unknown keys and keeps defaults", () => {
    const { config, warnings } = loadConfig(
      env,
      reading(
        '{"maxTaskSpaces": -1, "viewerPort": 80, "gcIntervalMs": 0, "colour": "red"}',
      ),
    );
    assert.equal(config.maxTaskSpaces, DEFAULT_CONFIG.maxTaskSpaces);
    assert.equal(config.viewerPort, DEFAULT_CONFIG.viewerPort);
    assert.equal(config.gcIntervalMs, DEFAULT_CONFIG.gcIntervalMs);
    assert.equal(warnings.length, 4);
  });

  it("ignores a file that is not a JSON object", () => {
    for (const text of ["[1]", "{nope"]) {
      const { config, warnings } = loadConfig(env, reading(text));
      assert.deepEqual(config, { ...DEFAULT_CONFIG });
      assert.equal(warnings.length, 1);
    }
  });
});
