export function pageNetworkResponsesCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/agent/network-app");
    const statusIs = (text) =>
      page.waitForFunction(
        (expected) => document.getElementById("status").textContent === expected,
        text,
        { timeout: 5000 }
      );

    // Arm the waiter, act, then read the parsed JSON.
    const pending = page.waitForResponse(/\\/agent\\/api\\/items/);
    await page.click("#load-items");
    const items = await pending;
    assertEqual(items.status, 200, "the response status is reported");
    assertEqual(items.method, "GET", "the request method is reported");
    assertEqual(items.resourceType, "Fetch", "the resource type is reported");
    assertIncludes(items.mimeType, "json", "the MIME type is reported");
    assertIncludes(items.headers["content-type"], "application/json", "headers are lowercased");
    assertEqual(items.json.query, "laptops", "the JSON body is parsed");
    assertEqual(items.json.items.length, 3, "the JSON body is complete");
    await statusIs("items 3");

    // Capture several responses while acting, until stop().
    const capture = await page.captureResponses({ match: "/agent/api/graphql" });
    await page.click("#load-graphql");
    await statusIs("graphql done");
    const responses = await capture.stop();
    assertEqual(responses.length, 3, "every matching response is captured");
    assertEqual(
      JSON.stringify(responses.map((response) => response.json.data.op)),
      "[1,2,3]",
      "responses arrive in order with parsed bodies"
    );
    assert(
      responses.every((response) => response.method === "POST"),
      "POST requests are captured"
    );
    const again = page.waitForResponse("/agent/api/graphql");
    await page.click("#load-graphql");
    await again;
    assertEqual(capture.responses().length, 3, "a stopped capture collects nothing more");

    // Size caps and binary bodies keep metadata with a reason.
    const big = page.waitForResponse("/agent/api/big", { maxBodyBytes: 1000000 });
    await page.click("#load-big");
    const bigResponse = await big;
    assertEqual(bigResponse.status, 200, "a large response still reports its status");
    assertEqual(bigResponse.json, undefined, "a body over maxBodyBytes is not kept");
    assertIncludes(bigResponse.bodyOmitted, "maxBodyBytes", "the omission says why");

    const image = page.waitForResponse("pixel.png");
    await page.click("#load-image");
    const imageResponse = await image;
    assertIncludes(imageResponse.bodyOmitted, "binary body", "a binary body is not decoded");

    await assertRejects(
      () => page.waitForResponse("/agent/api/never", { timeout: 300 }),
      "page.waitForResponse timed out after 300ms",
      "a waiter with no match times out"
    );
    await page.close();
  `;
}
