import test from "node:test";
import assert from "node:assert/strict";

import {
  closeFixtureServer,
  startFixtureServer,
} from "../scripts/real-browser-e2e/fixture.mjs";

test("the real-browser fixture uses a non-recursive cross-site iframe", async () => {
  const fixture = await startFixtureServer("fixture contract test");
  try {
    const homeHtml = await fetch(fixture.baseUrl).then((response) =>
      response.text(),
    );
    const iframeSrc = homeHtml.match(
      /<iframe id="fixture-frame" src="([^"]+)"/,
    )?.[1];

    assert.ok(iframeSrc, "the home fixture exposes its iframe URL");
    assert.notEqual(
      new URL(iframeSrc).hostname,
      new URL(fixture.baseUrl).hostname,
      "the iframe must be cross-site so Chromium exposes an OOPIF target",
    );

    const frameHtml = await fetch(iframeSrc).then((response) =>
      response.text(),
    );
    assert.match(frameHtml, /id="iframe-marker"/);
    assert.match(frameHtml, /id="iframe-action"/);
    assert.match(frameHtml, /id="iframe-field"/);
    assert.doesNotMatch(
      frameHtml,
      /id="fixture-frame"/,
      "the frame fixture must not recursively embed itself",
    );
  } finally {
    await closeFixtureServer(fixture.server);
  }
});

test("the agent fixture routes answer with the shapes the cases rely on", async () => {
  const fixture = await startFixtureServer("agent fixture contract test");
  try {
    const missing = await fetch(`${fixture.baseUrl}/agent/missing?code=404`);
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "", "the HTTP error has an empty body");

    const items = await fetch(`${fixture.baseUrl}/agent/api/items?q=x`);
    assert.deepEqual((await items.json()).items.length, 3);

    const graphql = await fetch(`${fixture.baseUrl}/agent/api/graphql`, {
      method: "POST",
      body: JSON.stringify({ op: 2 }),
    });
    assert.deepEqual(await graphql.json(), { data: { op: 2 } });

    const startedAt = Date.now();
    const rows = await fetch(`${fixture.baseUrl}/agent/api/rows?ms=150`);
    assert.equal((await rows.json()).rows.length, 5);
    assert(Date.now() - startedAt >= 140, "the rows endpoint is slow");

    for (const page of ["static", "delayed-rows", "settle-app", "busy"]) {
      const response = await fetch(`${fixture.baseUrl}/agent/${page}`);
      assert.equal(response.status, 200, page);
      assert.match(await response.text(), /<!doctype html>/, page);
    }
    const pixel = await fetch(`${fixture.baseUrl}/agent/api/pixel.png`);
    assert.equal(pixel.headers.get("content-type"), "image/png");
  } finally {
    await closeFixtureServer(fixture.server);
  }
});
