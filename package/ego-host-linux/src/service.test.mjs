import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  serviceCommand,
  systemdQuote,
  unitFile,
  unitText,
} from "./service.mjs";

function output() {
  let text = "";
  return { write: (chunk) => (text += chunk), text: () => text };
}

describe("unitText", () => {
  it("runs the daemon with restart on failure, settings and a memory cap", () => {
    const text = unitText({
      node: "/usr/bin/node",
      bin: "/opt/ego lite/bin/ego-browser.mjs",
      env: { EGO_LITE_CHROME: "/opt/chrome", SECRET_TOKEN: "x", HOME: "/h" },
      display: "virtual",
      memoryMaxMb: 4096,
    });
    assert.match(
      text,
      /^ExecStart="\/usr\/bin\/node" "\/opt\/ego lite\/bin\/ego-browser\.mjs" daemon$/m,
    );
    assert.match(text, /^Environment="EGO_LITE_CHROME=\/opt\/chrome"$/m);
    assert.match(text, /^Environment="EGO_LITE_DISPLAY=virtual"$/m);
    assert.match(text, /^Restart=on-failure$/m);
    assert.match(text, /^MemoryMax=4096M$/m);
    assert.doesNotMatch(text, /SECRET_TOKEN|@[A-Z_]+@/);
  });

  it("leaves out MemoryMax without a limit", () => {
    assert.doesNotMatch(unitText({ env: {} }), /MemoryMax/);
  });
});

describe("systemdQuote", () => {
  it("escapes quotes, backslashes, % and $", () => {
    assert.equal(systemdQuote('a"b\\c%d$e'), '"a\\"b\\\\c%%d$$e"');
    assert.throws(() => systemdQuote("a\nb"), /newline/);
  });
});

describe("serviceCommand", () => {
  it("installs without enabling, then uninstalls", () => {
    const env = {
      XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "ego-lite-unit-")),
    };
    const out = output();
    const calls = [];
    const run = (args) => {
      calls.push(args.join(" "));
      return "";
    };
    assert.equal(
      serviceCommand(["install", "--no-enable", "--display", "virtual"], {
        env,
        out,
        err: output(),
        maxRssMb: 3072,
        run,
      }),
      0,
    );
    const file = unitFile(env);
    assert.equal(
      file,
      join(env.XDG_CONFIG_HOME, "systemd", "user", "ego-lite.service"),
    );
    assert.match(readFileSync(file, "utf8"), /MemoryMax=4096M/);
    assert.deepEqual(calls, [], "--no-enable runs no systemctl");

    assert.equal(
      serviceCommand(["install"], { env, out, err: output(), run }),
      0,
    );
    assert.deepEqual(calls, ["daemon-reload", "enable --now ego-lite.service"]);
    assert.match(out.text(), /loginctl enable-linger/);

    assert.equal(
      serviceCommand(["uninstall"], { env, out, err: output(), run }),
      0,
    );
    assert.equal(existsSync(file), false);
    assert.ok(calls.includes("disable --now ego-lite.service"));
  });

  it("rejects unknown options", () => {
    const err = output();
    assert.equal(
      serviceCommand(["install", "--display", "tv"], {
        env: {},
        err,
        out: output(),
      }),
      2,
    );
    assert.equal(
      serviceCommand(["frobnicate"], { env: {}, err, out: output() }),
      2,
    );
  });
});
