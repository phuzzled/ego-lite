export function pageReadCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/extract/article");

    const article = await page.read();
    assertEqual(article.source, "article", "an <article> is the main content");
    assertEqual(article.title, "Fixture article", "the h1 inside the document title is the title");
    assertEqual(article.byline, "Ada Lovelace", "the author meta is the byline");
    assertEqual(article.published, "2026-10-31T09:00:00Z", "the published time is read");
    assertEqual(article.lang, "en", "the document language is read");
    assertIncludes(article.markdown, "# Fixture article", "the heading is Markdown");
    assertIncludes(article.markdown, "## Details", "subheadings keep their level");
    assertIncludes(article.markdown, "**strong words**", "strong text is bold");
    assertIncludes(article.markdown, "- First point", "list items are bullets");
    assertIncludes(article.markdown, "const answer = 42;", "code blocks are kept");
    assertIncludes(article.markdown, "| Name | Value |", "tables become Markdown tables");
    assertIncludes(
      article.markdown,
      "[related report](" + baseUrl + "/extract/related?x=1)",
      "links are absolute"
    );
    for (const noise of ["Home nav link", "advertisement", "Share on social", "Footer copyright", "Hidden article text"]) {
      assert(!article.markdown.includes(noise), "page chrome is dropped: " + noise);
    }
    assert(article.links.some((link) => link.href === baseUrl + "/extract/related?x=1"), "links are listed");
    assert(article.words > 60, "words are counted");
    assertEqual(article.truncated, false, "a short article is not truncated");

    const full = await page.read({ mode: "full" });
    assertEqual(full.source, "body", "mode full reads the body");
    assertIncludes(full.markdown, "Fixture article", "the full body has the article");

    const one = await page.read({ selector: "pre" });
    assertEqual(one.source, "selector", "a selector reads one element");
    assertIncludes(one.markdown, "const answer = 42;", "the selected element is read");
    await assertRejects(
      () => page.read({ selector: "#missing" }),
      "selector matched no element",
      "a selector that matches nothing fails clearly"
    );

    await page.goto(baseUrl + "/extract/teasers");
    const front = await page.read();
    assertEqual(front.source, "main", "a page of teaser articles is read from <main>");
    assertIncludes(front.markdown, "Teaser headline 1", "the first teaser is read");
    assertIncludes(front.markdown, "Teaser headline 12", "the last teaser is read too");

    await page.goto(baseUrl + "/extract/no-article");
    const soup = await page.read();
    assertEqual(soup.source, "main", "the densest block wins without an <article>");
    assert(!soup.markdown.includes("Menu one"), "menu links are not the main content");
    assert(!soup.markdown.includes("Sidebar link"), "sidebar links are not the main content");

    await page.goto(baseUrl + "/extract/long");
    const long = await page.read({ maxChars: 20000 });
    assertEqual(long.truncated, true, "a long page is truncated");
    assert(long.markdown.length <= 20000, "the Markdown fits maxChars");
    assert(long.markdown.endsWith("chrome around it."), "the cut falls between sections");
    assert(!/\\n## Section \\d+$/.test(long.markdown), "the cut does not end on a bare heading");

    await page.goto(baseUrl + "/extract/report.pdf");
    const pdf = await page.read();
    assertEqual(pdf.source, "pdf", "a PDF is read as a PDF");
    assertEqual(pdf.title, "Fixture report", "the PDF title comes from its info");
    assertEqual(pdf.pages.length, 2, "both PDF pages are read");
    assertIncludes(pdf.pages[0].text, "Revenue grew in the first quarter.", "page 1 text");
    assertIncludes(pdf.pages[1].text, "Costs fell.", "TJ spacing becomes a space");
    assertIncludes(pdf.markdown, "## Page 2", "each page is a section");

    await page.goto(baseUrl + "/api/openai-gpt-4-system-card.pdf");
    const card = await page.read({ maxChars: 5000 });
    assertEqual(card.source, "pdf", "a real-world PDF is read");
    assert(card.pages.length > 50, "every page of a long PDF is read");
    assertIncludes(card.markdown, "GPT-4 System Card", "its text is readable");
    assertEqual(card.truncated, true, "maxChars applies to PDFs");

    const saved = join(tempDir, "saved-report.pdf");
    await page.fetch(baseUrl + "/extract/report.pdf", { saveAs: saved });
    const local = await readPdf(saved);
    assertEqual(local.pages.length, 2, "readPdf reads a PDF on disk");

    // A snapshot leaves no observer behind in the page.
    await page.goto(baseUrl + "/extract/article");
    await page.snapshot();
    await page.waitForSettled({ timeout: 2000 });
    assertEqual(
      await page.evaluate(() => Object.getOwnPropertySymbols(globalThis).some((symbol) => String(symbol).includes("egoBrowser.settle"))),
      false,
      "snapshot and waitForSettled remove their observer"
    );
    await page.close();
  `;
}

export function pageTablesCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/extract/tables");

    const tables = await page.tables();
    assertEqual(tables.length, 2, "the data table and the grid are found; the layout table is not");
    const [spans, grid] = tables;
    assertEqual(spans.caption, "Population", "the caption is read");
    assertEqual(spans.selector, "#spans", "a unique id is the selector");
    assertEqual(
      JSON.stringify(spans.headers),
      JSON.stringify(["City", "Population / 2010", "Population / 2020"]),
      "two header rows are joined"
    );
    assertEqual(spans.rowCount, 3, "the empty spacer row is dropped");
    assertEqual(spans.rows[0].City, "Springfield", "footnote markers are dropped");
    assertEqual(spans.rows[0]["Population / 2010"], "1,234", "numbers stay text");
    assertEqual(spans.rows[2].City, "Shelbyville", "rowspan fills the next row");
    assertEqual(spans.rows[2]["Population / 2020"], "951", "cells after a rowspan line up");
    assertEqual(grid.kind, "grid", "an ARIA grid is read");
    assertEqual(grid.caption, "Orders", "aria-label is the grid caption");
    assertEqual(JSON.stringify(grid.headers), JSON.stringify(["Order", "Total"]), "column headers");
    assertEqual(grid.rows[1].Total, "$12.50", "grid cells are read");

    const one = await page.tables({ selector: "#grid", csv: true });
    assertEqual(one.length, 1, "a selector picks one table");
    assertEqual(one[0].csv, "Order,Total\\r\\nA-1,$10.00\\r\\nA-2,$12.50\\r\\n", "CSV is RFC 4180");
    const csvPath = join(tempDir, "tables", "spans.csv");
    await page.tables({ index: 0, saveAs: csvPath });
    const csv = await readFile(csvPath, "utf8");
    assertIncludes(csv, '"1,234"', "CSV quotes values with commas");
    await assertRejects(
      () => page.tables({ saveAs: csvPath }),
      "pass index",
      "saveAs needs one table"
    );
    await assertRejects(
      () => page.tables({ index: 9 }),
      "out of range",
      "an index past the end fails clearly"
    );

    await page.goto(baseUrl + "/extract/structured");
    const data = await page.structuredData();
    assertEqual(data.jsonLd.length, 2, "@graph is flattened");
    assertEqual(data.jsonLd[1].headline, "Structured headline", "JSON-LD entities are kept");
    assertEqual(data.jsonLd[1]["@context"], "https://schema.org", "the context is carried into graph nodes");
    assertEqual(data.openGraph["og:title"], "OG title", "OpenGraph tags are read");
    assertEqual(data.openGraph["og:image"].length, 2, "repeated OpenGraph tags become a list");
    assertEqual(data.twitter["twitter:card"], "summary", "Twitter card tags are read");
    assertEqual(data.description, "A structured fixture", "the meta description is read");
    assertEqual(data.canonical, baseUrl + "/extract/structured?canonical=1", "the canonical URL is absolute");
    assertEqual(data.microdata[0]["@type"][0], "Product", "microdata types are read");
    assertEqual(data.microdata[0].offers.price, "9.99", "nested microdata is read");

    await page.goto(baseUrl + "/extract/tall");
    const tiles = await page.screenshot({ fullPage: true, tiles: true, maxHeight: 4000, path: join(artifactDir, "tall.png") });
    assertEqual(tiles.length, 3, "a 9000 px page is three 4000 px tiles");
    for (const tile of tiles) assert((await stat(tile)).size > 0, "each tile is written: " + tile);
    const capped = await page.screenshot({ fullPage: true, maxHeight: 5000 });
    const png = await readFile(capped);
    assertEqual(png.readUInt32BE(20), 5000, "fullPage stops at maxHeight");
    await assertRejects(
      () => page.screenshot({ tiles: true }),
      "need fullPage: true",
      "tiles need fullPage"
    );
    await page.close();
  `;
}

export function pageConsentCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/extract/consent?kind=onetrust");
    const consent = () => page.evaluate(() => window.__consent);

    let result = await page.dismissConsent();
    assertEqual(result.found, true, "a OneTrust banner is found");
    assertEqual(result.action, "reject", "the default choice is reject");
    assertEqual(result.framework, "onetrust", "the platform is named");
    assertEqual(result.clicked, "Reject All", "the clicked button is reported");
    assertEqual(result.dismissed, true, "the banner is gone afterwards");
    assertEqual(await consent(), "rejected", "the page saw a reject");

    await page.goto(baseUrl + "/extract/consent?kind=cookiebot");
    result = await page.dismissConsent();
    assertEqual(result.framework, "cookiebot", "Cookiebot is matched");
    assertEqual(await consent(), "rejected", "Cookiebot is rejected");

    await page.goto(baseUrl + "/extract/consent?kind=generic");
    result = await page.dismissConsent();
    assertEqual(result.framework, "generic", "a dialog is matched by its text");
    assertEqual(result.clicked, "Only necessary cookies", "necessary-only counts as reject");
    assertEqual(await consent(), "rejected", "the generic banner is rejected");

    await page.goto(baseUrl + "/extract/consent?kind=late");
    result = await page.dismissConsent({ timeout: 3000 });
    assertEqual(result.action, "reject", "a late banner is waited for");
    assertEqual(await consent(), "rejected", "the late banner is rejected");

    await page.goto(baseUrl + "/extract/consent?kind=accept-only");
    result = await page.dismissConsent();
    assertEqual(result.found, true, "an accept-only banner is found");
    assertEqual(result.action, "none", "accept-only is never accepted by default");
    assertEqual(await consent(), "unset", "nothing was clicked");
    result = await page.dismissConsent({ prefer: "accept" });
    assertEqual(result.action, "accept", "prefer accept accepts");
    assertEqual(await consent(), "accepted", "the page saw an accept");

    await page.goto(baseUrl + "/extract/consent?kind=none");
    const started = Date.now();
    result = await page.dismissConsent({ timeout: 300 });
    assertEqual(result.found, false, "no banner is reported as not found");
    assert(Date.now() - started < 3000, "a page with no banner answers fast");
    await page.close();
  `;
}

export function pageScrollPaginateCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/extract/infinite");

    const loaded = await page.scrollToLoad({ itemSelector: ".item", maxScrolls: 20, idleMs: 1500 });
    assertEqual(loaded.items, 100, "the list loads all its items");
    assertEqual(loaded.stoppedBecause, "no new items", "it stops when nothing new appears");
    const capped = await page.reload().then(() => page.scrollToLoad({ itemSelector: ".item", maxItems: 40 }));
    assert(capped.items >= 40, "maxItems is reached");
    assertEqual(capped.stoppedBecause, "maxItems reached", "it stops at maxItems");

    await page.goto(baseUrl + "/extract/pages?n=1");
    const rows = [];
    let visited = 0;
    for await (const current of page.paginate({ next: "loc=role:link[name='Next']", maxPages: 5 })) {
      visited += 1;
      rows.push(...(await current.tables())[0].rows.map((row) => row.Name));
    }
    assertEqual(visited, 3, "pagination stops when Next is gone");
    assertEqual(rows.join(","), "row 1.1,row 1.2,row 2.1,row 2.2,row 3.1,row 3.2", "each page is read once");
    await page.goto(baseUrl + "/extract/pages?n=1");
    visited = 0;
    for await (const _ of page.paginate({ next: "loc=role:link[name='Next']", maxPages: 2 })) visited += 1;
    assertEqual(visited, 2, "maxPages limits the pages");
    await page.close();

    const before = (await task.pages()).length;
    const urls = [1, 2, 3].map((n) => baseUrl + "/extract/pages?n=" + n).concat([baseUrl + "/agent/missing?code=404"]);
    const mapped = await task.map(urls, async (p) => (await p.title()), { concurrency: 2 });
    assertEqual(mapped.length, 4, "every URL has a result");
    assertEqual(mapped.slice(0, 3).map((r) => r.value).join(","), "Page 1,Page 2,Page 3", "results keep input order");
    assertEqual(mapped[3].ok, false, "a failed URL is reported, not thrown");
    assert(mapped[3].error.length > 0, "the failure has a message");
    assertEqual((await task.pages()).length, before, "task.map closes its Pages");
  `;
}

export function hostFeaturesCase() {
  return `
    const caps = globalThis.ego.getHostCapabilities?.() || {};
    if (!caps.taskSpaceMemo) {
      await assertRejects(() => (async () => (await taskSpace(taskName)).memo("k"))(), "not supported on this browser host", "memo explains it is unsupported");
    } else {
      const task = await taskSpace(taskName);
      assertEqual(await task.memo("e2e-step"), undefined, "an unset memo is undefined");
      await task.memo("e2e-step", { done: true, n: 2 });
      assertEqual((await task.memo("e2e-step")).n, 2, "a memo value is kept");
      await task.memo("e2e-step", null);
      assertEqual(await task.memo("e2e-step"), undefined, "null deletes a memo");
      await assertRejects(() => task.memo("__ego.pageUrls", 1), "reserved", "SDK keys are reserved");

      const relayPage = await newPageAt(task, baseUrl + "/extract/article");
      const relay = await task.handOff({ relay: true });
      assert(relay && relay.relay, "relay returns its files");
      assert((await stat(relay.relay.screenshot)).size > 0, "the relay screenshot exists");
      assertEqual(await relayPage.title(), "Fixture article - Example News", "the agent keeps control after a relay");

      const ttlName = taskName + " ttl";
      const ttlTask = await taskSpace(ttlName, { ttlMs: 60000 });
      assert(ttlTask.spaceId > 0, "a space with a TTL is created");
      await ttlTask.finish();

      // Every Page action is logged for this round.
      await relayPage.goto(baseUrl + "/extract/tables");
      await relayPage.tables();
      await relayPage.close();
    }
    assertEqual(typeof (await taskSpace(taskName)).finish, "function", "the space still works");
  `;
}

export function hostRoundLogCase() {
  return `
    const caps = globalThis.ego.getHostCapabilities?.() || {};
    if (caps.logEvent) {
      const task = await taskSpace(taskName);
      const { homedir } = await import("node:os");
      const file = join(homedir(), ".local", "state", "ego-lite", "rounds", task.spaceId + ".jsonl");
      const lines = (await readFile(file, "utf8")).trim().split("\\n").map((line) => JSON.parse(line));
      const actions = lines.map((line) => line.action);
      assert(actions.includes("page.goto"), "page.goto is in the round log");
      assert(actions.includes("page.tables"), "page.tables is in the round log");
      const goto = lines.findLast((line) => line.action === "page.goto");
      assertEqual(goto.ok, true, "the outcome is logged");
      assert(!JSON.stringify(goto).includes("/extract/"), "URL paths stay out of the log");
    } else {
      assert(true, "this host has no round log");
    }
  `;
}

export function restorePrepareCase() {
  return `
    const caps = globalThis.ego.getHostCapabilities?.() || {};
    const task = await taskSpace(taskName);
    if (caps.restoreTaskSpaceTabs) {
      const page = await newPageAt(task, baseUrl + "/extract/pages?n=2");
      await writeFile(join(tempDir, "restore-label.json"), JSON.stringify({ label: page.label }));
    }
    assert(true, "prepared");
  `;
}

export function restoreResumeCase() {
  return `
    const caps = globalThis.ego.getHostCapabilities?.() || {};
    if (caps.restoreTaskSpaceTabs) {
      const { label } = JSON.parse(await readFile(join(tempDir, "restore-label.json"), "utf8"));
      const task = await taskSpace(taskName, { restorePages: true });
      const page = task.page(label);
      assertEqual(await page.url(), baseUrl + "/extract/pages?n=2", "the Page is back at its URL with its label");
      assertEqual(await page.title(), "Page 2", "the restored Page works");
      await page.close();
    } else {
      assert(true, "this host cannot restore Pages");
    }
  `;
}

export function hostIdentityCase() {
  return `
    const caps = globalThis.ego.getHostCapabilities?.() || {};
    if (!caps.ephemeralProfile || !caps.fillSecret) {
      const page = await newPageAt(await taskSpace(taskName), baseUrl + "/extract/login");
      if (!caps.fillSecret) {
        await assertRejects(
          () => page.fillSecret("#password", "e2e-secret"),
          "not supported on this browser host",
          "fillSecret explains it is unsupported"
        );
      }
      await page.close();
    } else {
    const rejectsWithCode = async (fn, code, message) => {
      try {
        await fn();
      } catch (error) {
        assertEqual(error.error_code, code, message);
        assert(typeof error.hint === "string" && error.hint.length > 0, message + " (with a hint)");
        return;
      }
      throw new Error(message + ": expected rejection");
    };
    const list = await profiles();
    assert(list.some((profile) => profile.id === "ephemeral" && profile.ephemeral === true), "the ephemeral profile is listed");

    // A throwaway space: its own cookies, deleted by finish().
    const name = taskName + " ephemeral";
    const throwaway = await taskSpace(name, { profileId: "ephemeral" });
    assertEqual(throwaway.profileId, "ephemeral", "the space knows its profile");
    const page = throwaway.page("p1");
    await page.goto(baseUrl + "/extract/login");
    await page.evaluate(() => { document.cookie = "e2e_ephemeral=1; path=/"; });
    const main = await newPageAt(await taskSpace(taskName), baseUrl + "/extract/login");
    assert(!(await main.evaluate(() => document.cookie)).includes("e2e_ephemeral"), "the ephemeral cookie stays in its space");
    const receipt = await throwaway.finish({ keep: "all" });
    assertEqual(receipt.closedSpace, true, "finish reports an ephemeral space as closed");
    assertEqual(receipt.keptManagedLabels.length, 0, "no Page outlives an ephemeral space");
    assert(!(await listTaskSpaces()).some((space) => space.name === name), "the ephemeral space is gone");

    // A stored secret is typed without reaching the script.
    const { spawnSync } = await import("node:child_process");
    const origin = new URL(baseUrl).origin;
    const set = spawnSync(process.execPath, [process.argv[1], "secret", "set", "e2e-secret", "--origin", origin], {
      input: "s3cret-value\\n",
      encoding: "utf8",
    });
    assertEqual(set.status, 0, "the secret is stored: " + set.stderr);
    try {
      const filled = await main.fillSecret("#password", "e2e-secret");
      assertEqual(filled.filled, true, "the secret is filled");
      assertEqual(filled.origin, origin, "the origin is reported");
      assert(!JSON.stringify(filled).includes("s3cret"), "the value is not returned");
      assertEqual(await main.evaluate(() => document.querySelector("#password").value.length), 12, "the field holds the secret");
      const snap = await main.snapshot();
      assert(!snap.includes("s3cret"), "the snapshot does not show the secret");
      await rejectsWithCode(() => main.fillSecret("#password", "e2e-missing"), "EGO_SECRET_NOT_FOUND", "an unknown secret is reported");
      const other = baseUrl.replace("127.0.0.1", "localhost");
      await main.goto(other + "/extract/login");
      await rejectsWithCode(() => main.fillSecret("#password", "e2e-secret"), "EGO_SECRET_ORIGIN_MISMATCH", "another origin is refused");
    } finally {
      spawnSync(process.execPath, [process.argv[1], "secret", "remove", "e2e-secret"], { encoding: "utf8" });
      await main.close();
    }
    }
  `;
}
