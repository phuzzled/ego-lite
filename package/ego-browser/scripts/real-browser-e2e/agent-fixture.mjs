/**
 * Fixture routes for the agent-roadmap cases: pages that draw late, keep
 * polling, never settle, or load JSON, plus an empty-body HTTP error.
 * All routes live under /agent/.
 */

const ROW_TEXT =
  "row with enough descriptive text that a reader would call it real content";

/** Handle one /agent/ request. Returns false for an unknown path. */
export function handleAgentFixture(url, req, res) {
  switch (url.pathname) {
    case "/agent/missing":
      // An HTTP error with an empty body: Chromium reports only
      // net::ERR_HTTP_RESPONSE_CODE_FAILURE for it.
      res.writeHead(Number(url.searchParams.get("code") || 404), {
        "cache-control": "no-store",
      });
      res.end();
      return true;
    case "/agent/static":
      html(
        res,
        "Static fixture",
        `<h1>Static fixture</h1><p>${"This page is fully drawn when it loads. ".repeat(12)}</p>`,
      );
      return true;
    case "/agent/delayed-rows": {
      // Rows appear on a timer after load, with no network request.
      const ms = Number(url.searchParams.get("ms") || 1500);
      html(
        res,
        "Delayed rows",
        `<main id="list"></main>
        <script>
          setTimeout(() => {
            document.getElementById("list").innerHTML = ["alpha", "beta", "gamma", "delta", "epsilon"]
              .map((name) => '<div class="row">' + name + " ${ROW_TEXT}</div>")
              .join("");
          }, ${ms});
        </script>`,
      );
      return true;
    }
    case "/agent/settle-app": {
      // Rows come from a slow fetch; the page then polls forever without
      // changing the DOM, so network idle never arrives.
      const ms = Number(url.searchParams.get("ms") || 1500);
      html(
        res,
        "Settle app",
        `<main id="list">Loading</main>
        <script>
          window.__polls = 0;
          fetch("/agent/api/rows?ms=${ms}")
            .then((response) => response.json())
            .then((data) => {
              document.getElementById("list").innerHTML = data.rows
                .map((name) => '<div class="row" role="row">' + name + " ${ROW_TEXT}</div>")
                .join("");
            });
          // Like an analytics beacon, the poll never reads its body.
          setInterval(() => {
            fetch("/agent/api/poll?n=" + window.__polls++);
          }, 200);
        </script>`,
      );
      return true;
    }
    case "/agent/busy":
      // The DOM changes every 150 ms forever.
      html(
        res,
        "Busy fixture",
        `<h1>Busy fixture</h1><p id="ticker">0</p>
        <script>
          let ticks = 0;
          setInterval(() => {
            document.getElementById("ticker").textContent = String(++ticks);
          }, 150);
        </script>`,
      );
      return true;
    case "/agent/network-app":
      html(
        res,
        "Network app",
        `<h1>Network app</h1>
        <button id="load-items">Load items</button>
        <button id="load-graphql">Run three queries</button>
        <button id="load-big">Load a big body</button>
        <button id="load-image">Load an image</button>
        <p id="status">idle</p>
        <script>
          const status = document.getElementById("status");
          document.getElementById("load-items").onclick = async () => {
            const response = await fetch("/agent/api/items?q=laptops");
            const data = await response.json();
            status.textContent = "items " + data.items.length;
          };
          document.getElementById("load-graphql").onclick = async () => {
            for (const op of [1, 2, 3]) {
              const response = await fetch("/agent/api/graphql", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ op }),
              });
              await response.json();
            }
            status.textContent = "graphql done";
          };
          document.getElementById("load-big").onclick = async () => {
            await (await fetch("/agent/api/big?n=3000000")).text();
            status.textContent = "big done";
          };
          document.getElementById("load-image").onclick = async () => {
            await (await fetch("/agent/api/pixel.png")).blob();
            status.textContent = "image done";
          };
        </script>`,
      );
      return true;
    case "/agent/api/rows": {
      const ms = Number(url.searchParams.get("ms") || 1500);
      setTimeout(() => {
        json(res, { rows: ["alpha", "beta", "gamma", "delta", "epsilon"] });
      }, ms);
      return true;
    }
    case "/agent/api/poll":
      json(res, { ok: true });
      return true;
    case "/agent/api/items":
      json(res, {
        query: url.searchParams.get("q"),
        items: [
          { id: 1, name: "Laptop one" },
          { id: 2, name: "Laptop two" },
          { id: 3, name: "Laptop three" },
        ],
      });
      return true;
    case "/agent/api/graphql": {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        let op = null;
        try {
          op = JSON.parse(body).op;
        } catch {
          // Report a null op for a malformed request.
        }
        json(res, { data: { op } });
      });
      return true;
    }
    case "/agent/api/big": {
      const n = Math.max(0, Number(url.searchParams.get("n") || 0));
      json(res, { blob: "x".repeat(n) });
      return true;
    }
    case "/agent/api/pixel.png":
      res.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "no-store",
      });
      res.end(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "base64",
        ),
      );
      return true;
    default:
      return false;
  }
}

function html(res, title, body) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`,
  );
}

function json(res, value) {
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}
