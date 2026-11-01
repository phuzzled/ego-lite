export function pageSnapshotStatsCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/agent/delayed-rows?ms=2000");

    // Snapped at once, the rows are not drawn yet: the snapshot says so.
    const early = await page.snapshot({ format: "object" });
    assert(early.stats, "a snapshot reports stats");
    assertEqual(early.stats.readyState, "complete", "the document has loaded");
    assert(
      early.stats.textChars < 200,
      "the page has little text before its rows: " + early.stats.textChars
    );
    assertEqual(early.warnings.length, 1, "an unfinished page gets one warning");
    assertIncludes(
      early.warnings[0],
      "page may still be rendering",
      "the warning names the problem"
    );
    assertIncludes(
      early.text,
      "\\n[warning page may still be rendering",
      "the default text carries the warning line"
    );
    assert(
      /^\\[p\\d+ [^\\n]*\\]\\n\\[stats nodes=\\d+ refs=\\d+ text=\\d+ readyState=complete (pendingRequests=\\d+ )?domChanging=(yes|no)\\]\\n/.test(
        early.text
      ),
      "the stats line follows the header: " + early.text.split("\\n").slice(0, 2).join(" / ")
    );

    // After a content wait the same page snapshots clean.
    await page.waitForSelector(".row", { timeout: 5000 });
    const late = await page.snapshot({ format: "object" });
    assertEqual(late.warnings.length, 0, "a drawn page has no warning");
    assert(late.stats.textChars > 200, "the rows add text: " + late.stats.textChars);
    assertIncludes(late.text, "alpha row", "the rows are in the snapshot");
    const text = await page.snapshot();
    assertEqual(typeof text, "string", "the default snapshot is still a string");
    assert(!text.includes("[warning"), "the default text has no warning line");

    // A static page is not flagged as unfinished.
    await page.goto(baseUrl + "/agent/static");
    const staticSnapshot = await page.snapshot({ format: "object" });
    assertEqual(staticSnapshot.warnings.length, 0, "a static page has no warning");
    assertEqual(staticSnapshot.stats.domChanging, false, "the snapshot does not change the DOM");

    // P1: an empty-body HTTP error names its status and the next step.
    let httpError;
    try {
      await page.goto(baseUrl + "/agent/missing?code=404");
    } catch (error) {
      httpError = error;
    }
    assert(httpError, "goto to a 404 with an empty body fails");
    assertEqual(httpError.error_code, "EGO_NAVIGATION_HTTP_ERROR", "the failure has a stable code");
    assertEqual(httpError.status, 404, "the failure reports the HTTP status");
    assertIncludes(httpError.message, "HTTP 404", "the message names the status");
    assertIncludes(httpError.hint, "page.fetch(url)", "the hint gives the next step");
    assertIncludes(httpError.stack, "\\n  hint: ", "the hint is printed after the stack");
    await page.close();
  `;
}
