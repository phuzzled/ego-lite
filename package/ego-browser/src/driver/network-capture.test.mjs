import test from "node:test";
import assert from "node:assert/strict";

import {
  compileResponseMatcher,
  ResponseCollector,
} from "../../dist/src/driver/network-capture.js";

const SESSION = "session:page";

/** A fake CDP whose response bodies come from a map keyed by requestId. */
function bodyServices(bodies) {
  const reads = [];
  return {
    reads,
    async cdp(method, params, sessionId) {
      assert.equal(method, "Network.getResponseBody");
      assert.equal(sessionId, SESSION);
      reads.push(params.requestId);
      const body = bodies[params.requestId];
      if (body instanceof Error) throw body;
      if (body === undefined)
        throw new Error("No resource with given identifier found");
      return body;
    },
  };
}

function load(
  collector,
  requestId,
  {
    url = `https://example.test/api/${requestId}`,
    status = 200,
    mimeType = "application/json",
    type = "Fetch",
    method = "GET",
    size = 10,
    headers = { "Content-Type": mimeType },
    finish = true,
    sessionId = SESSION,
  } = {},
) {
  collector.handleEvent({
    sessionId,
    method: "Network.requestWillBeSent",
    params: { requestId, request: { url, method }, type },
  });
  collector.handleEvent({
    sessionId,
    method: "Network.responseReceived",
    params: {
      requestId,
      type,
      response: { url, status, statusText: "OK", headers, mimeType },
    },
  });
  if (finish) {
    collector.handleEvent({
      sessionId,
      method: "Network.loadingFinished",
      params: { requestId, encodedDataLength: size },
    });
  }
}

test("matched JSON, text and binary responses are kept with the right body", async () => {
  const services = bodyServices({
    a: { body: '{"items":[1,2,3]}', base64Encoded: false },
    b: {
      body: Buffer.from("plain words").toString("base64"),
      base64Encoded: true,
    },
  });
  const collector = new ResponseCollector(services, SESSION, {}, "test");
  load(collector, "a");
  load(collector, "b", { mimeType: "text/plain", type: "XHR", method: "POST" });
  load(collector, "img", { mimeType: "image/png", type: "Fetch" });
  load(collector, "doc", { mimeType: "text/html", type: "Document" });
  const responses = await collector.stop();

  assert.deepEqual(
    responses.map((response) => response.url),
    [
      "https://example.test/api/a",
      "https://example.test/api/b",
      "https://example.test/api/img",
    ],
    "without a matcher only fetch and XHR responses are kept",
  );
  assert.deepEqual(responses[0].json, { items: [1, 2, 3] });
  assert.equal(responses[0].text, undefined);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].method, "GET");
  assert.equal(responses[0].headers["content-type"], "application/json");
  assert.equal(responses[0].bodySize, 17);
  assert.equal(responses[0].fromCache, false);
  assert.equal(responses[1].text, "plain words");
  assert.equal(responses[1].method, "POST");
  assert.match(responses[2].bodyOmitted, /^binary body \(image\/png\)/);
  assert.deepEqual(services.reads, ["a", "b"], "binary bodies are not read");
});

test("string, RegExp and predicate matchers select responses", () => {
  const info = {
    url: "https://example.test/api/items?page=2",
    status: 200,
    method: "GET",
    resourceType: "Fetch",
  };
  assert.equal(compileResponseMatcher("/api/items", "t")(info), true);
  assert.equal(compileResponseMatcher("**/api/items?*", "t")(info), true);
  assert.equal(compileResponseMatcher("/api/users", "t")(info), false);
  assert.equal(compileResponseMatcher(/items\?page=\d/, "t")(info), true);
  assert.equal(
    compileResponseMatcher(
      (r) => r.status === 200 && r.method === "GET",
      "t",
    )(info),
    true,
  );
  assert.equal(
    compileResponseMatcher(undefined, "t")({ ...info, resourceType: "Script" }),
    false,
  );
  for (const bad of ["", 5, null, {}]) {
    assert.throws(
      () => compileResponseMatcher(bad, "page.waitForResponse"),
      /page\.waitForResponse matcher must be a non-empty URL string, a RegExp, or a function/,
    );
  }
});

test("body caps omit large bodies with a reason", async () => {
  const big = "x".repeat(2_000);
  const services = bodyServices({
    small: { body: '"ok"', base64Encoded: false },
    liar: { body: JSON.stringify(big), base64Encoded: false },
    t1: { body: "a".repeat(600), base64Encoded: false },
    t2: { body: "b".repeat(600), base64Encoded: false },
  });
  const collector = new ResponseCollector(
    services,
    SESSION,
    { match: "/api/", maxBodyBytes: 1_000, maxTotalBytes: 1_000 },
    "test",
  );
  load(collector, "small");
  load(collector, "declared", { size: 5_000 });
  // The encoded length can be small for a compressed body.
  load(collector, "liar", { size: 100 });
  const first = await collector.stop();
  assert.equal(first[0].json, "ok");
  assert.match(first[1].bodyOmitted, /body larger than maxBodyBytes \(1000\)/);
  assert.equal(first[1].json, undefined);
  assert.match(first[2].bodyOmitted, /body larger than maxBodyBytes/);
  assert.equal(first[2].bodySize, 2_002);
  assert.deepEqual(services.reads, ["small", "liar"]);

  const total = new ResponseCollector(
    services,
    SESSION,
    { match: "/api/", maxTotalBytes: 1_000 },
    "test",
  );
  load(total, "t1", { mimeType: "text/plain" });
  load(total, "t2", { mimeType: "text/plain" });
  const totals = await total.stop();
  assert.equal(totals[0].text.length, 600);
  assert.match(totals[1].bodyOmitted, /maxTotalBytes \(1000\) reached/);
});

test("maxBodies keeps later responses as metadata only", async () => {
  const services = bodyServices({
    r1: { body: "[1]", base64Encoded: false },
    r2: { body: "[2]", base64Encoded: false },
    r3: { body: "[3]", base64Encoded: false },
  });
  const collector = new ResponseCollector(
    services,
    SESSION,
    { match: /api/, maxBodies: 2 },
    "test",
  );
  for (const id of ["r1", "r2", "r3"]) load(collector, id);
  const responses = await collector.stop();
  assert.deepEqual(
    responses.map((r) => r.json ?? r.bodyOmitted),
    [[1], [2], "maxBodies (2) reached"],
  );
});

test("failed loads, unfinished loads and body errors keep their metadata", async () => {
  const services = bodyServices({
    gone: new Error("No resource with given identifier found"),
  });
  const collector = new ResponseCollector(
    services,
    SESSION,
    { match: "/api/" },
    "test",
  );
  load(collector, "failed", { finish: false });
  collector.handleEvent({
    sessionId: SESSION,
    method: "Network.loadingFailed",
    params: { requestId: "failed", errorText: "net::ERR_ABORTED" },
  });
  load(collector, "pending", { finish: false });
  load(collector, "gone");
  load(collector, "empty", { status: 204 });
  const responses = await collector.stop();
  const byUrl = Object.fromEntries(
    responses.map((r) => [r.url.split("/").at(-1), r]),
  );
  assert.equal(byUrl.failed.bodyOmitted, "loading failed: net::ERR_ABORTED");
  assert.equal(byUrl.pending.bodyOmitted, "loading had not finished");
  assert.match(byUrl.gone.bodyOmitted, /^body unavailable: No resource/);
  assert.equal(byUrl.empty.status, 204);
  assert.equal(byUrl.empty.bodyOmitted, undefined);
  assert.equal(responses.length, 4);
});

test("events after stop and from other sessions are ignored", async () => {
  const services = bodyServices({ x: { body: "{}", base64Encoded: false } });
  const seen = [];
  const collector = new ResponseCollector(
    services,
    SESSION,
    { match: "/api/", onResponse: (r) => seen.push(r.url) },
    "test",
  );
  load(collector, "other", { sessionId: "session:iframe" });
  assert.deepEqual(await collector.stop(), []);
  load(collector, "x");
  assert.deepEqual(collector.responses(), []);
  assert.deepEqual(seen, []);
});

test("a throwing predicate is reported and does not break the stream", async () => {
  const errors = [];
  const collector = new ResponseCollector(
    bodyServices({}),
    SESSION,
    {
      match: (response) => response.url.missing.method(),
      onMatchError: (error) => errors.push(error),
    },
    "test",
  );
  load(collector, "a");
  assert.equal(errors.length, 1);
  assert(errors[0] instanceof TypeError);
  assert.deepEqual(await collector.stop(), []);
});
