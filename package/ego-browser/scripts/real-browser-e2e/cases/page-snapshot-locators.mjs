export function pageSnapshotLocatorCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?workflow=page-snapshot-locators");

    await page.evaluate(() => {
      const region = document.createElement("section");
      region.innerHTML =
        '<a href="/nav-target?locator=duplicate">First duplicate</a>' +
        '<a href="/nav-target?locator=duplicate">Second duplicate</a>' +
        '<a href="/nav-target?locator=unique">Unique destination</a>';
      document.body.append(region);
    });

    const snapshot = await page.snapshot({ scope: "full_page" });
    const duplicateLines = snapshot
      .split("\\n")
      .filter((line) => line.includes("locator=duplicate"));
    assertEqual(duplicateLines.length, 2, "snapshot contains both duplicate links");
    assert(
      duplicateLines.every((line) => !line.includes(", loc=")),
      "snapshot does not advertise a duplicate href as a stable locator"
    );
    assertIncludes(
      snapshot,
      "loc=href:/nav-target?locator=unique",
      "snapshot keeps a unique href locator"
    );
    await page.waitForSelector("loc=href:/nav-target?locator=unique", {
      state: "attached",
      timeout: 2_000,
    });

    // Locator checks must stay linear: thousands of links once took over
    // ten seconds and starved other CDP calls.
    await page.evaluate(() => {
      const many = document.createElement("section");
      many.innerHTML = Array.from(
        { length: 3000 },
        (_, index) =>
          '<a href="/nav-target?bulk=' + index + '">Bulk ' + index + "</a>" +
          "<button>Bulk button " + index + "</button>",
      ).join("");
      document.body.append(many);
    });
    const started = Date.now();
    const large = await page.snapshot({ scope: "full_page" });
    const elapsed = Date.now() - started;
    assert(elapsed < 10_000, "a 6000-control snapshot finishes in " + elapsed + "ms");
    assertIncludes(
      large,
      "loc=href:/nav-target?bulk=2999",
      "the last bulk link keeps its href locator"
    );
    assertIncludes(
      large,
      'loc=role:button[name="Bulk button 2999"]',
      "the last bulk button keeps its role locator"
    );
    assert(
      large
        .split("\\n")
        .filter((line) => line.includes("locator=duplicate"))
        .every((line) => !line.includes(", loc=")),
      "duplicate hrefs stay without a locator on a large page"
    );

    await page.close();
  `;
}
