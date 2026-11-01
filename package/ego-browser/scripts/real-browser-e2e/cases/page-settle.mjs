export function pageSettleCase() {
  return `
    const task = await taskSpace(taskName);

    // A static page settles after one quiet window.
    const page = await newPageAt(task, baseUrl + "/agent/static");
    let startedAt = Date.now();
    const quick = await page.waitForSettled();
    const quickMs = Date.now() - startedAt;
    assertEqual(quick.settled, true, "a static page settles");
    assertEqual(quick.pendingRequests, 0, "a static page has no pending requests");
    assert(quickMs < 1500, "a static page settles quickly: " + quickMs + " ms");

    // Rows from a slow fetch, then polling forever with no DOM change.
    await page.goto(baseUrl + "/agent/settle-app?ms=1500");
    startedAt = Date.now();
    const app = await page.waitForSettled({ timeout: 10000 });
    const appMs = Date.now() - startedAt;
    assertEqual(app.settled, true, "the app settles once its rows are drawn: " + JSON.stringify(app));
    assert(app.waitedMs >= 1000, "settling waited for the slow fetch: " + app.waitedMs);
    assert(appMs < 6000, "settling did not wait for the endless polling: " + appMs);
    assertEqual(
      await page.evaluate(() => document.querySelectorAll(".row").length),
      5,
      "every row is drawn when the page settles"
    );
    assert(
      await page.evaluate(() => window.__polls > 2),
      "the page keeps polling the network"
    );
    await assertRejects(
      () => page.waitForLoadState("networkidle", { timeout: 1500 }),
      "networkidle",
      "the polling page never reaches network idle"
    );

    // until and minCount, and snapshot({ settle }) in one call.
    await page.goto(baseUrl + "/agent/settle-app?ms=1000");
    const counted = await page.waitForSettled({ until: ".row", minCount: 5, timeout: 10000 });
    assertEqual(counted.settled, true, "until waits for the rows");
    assertEqual(counted.matches, 5, "until reports its match count");

    await page.goto(baseUrl + "/agent/settle-app?ms=1000");
    const snapshot = await page.snapshot({ settle: true, format: "object" });
    assertEqual(snapshot.settle.settled, true, "snapshot settle waits first");
    assertIncludes(snapshot.text, "alpha row", "the settled snapshot has the rows");
    assertEqual(snapshot.warnings.length, 0, "a settled snapshot has no warning");

    // A page that never stops changing returns at its timeout, without throwing.
    await page.goto(baseUrl + "/agent/busy");
    startedAt = Date.now();
    const busy = await page.waitForSettled({ timeout: 1500 });
    const busyMs = Date.now() - startedAt;
    assertEqual(busy.settled, false, "a busy page does not settle");
    assertEqual(busy.reason, "dom still changing", "the result says why");
    assert(busy.mutationsSeen >= 3, "the DOM changes are counted: " + busy.mutationsSeen);
    assert(busyMs < 3000, "the wait ends at its timeout: " + busyMs + " ms");
    await page.close();
  `;
}
