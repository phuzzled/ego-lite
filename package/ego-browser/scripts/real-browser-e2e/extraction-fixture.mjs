/**
 * Fixture routes for the extraction and navigation cases: an article with
 * page chrome, tables, structured data, consent banners, an infinite list,
 * a paginated list, a tall page, and a generated two-page PDF. All routes
 * live under /extract/.
 */
import { deflateSync } from "node:zlib";

const PARAGRAPH =
  "The article body is the part a reader came for, and it carries enough plain words that any readability scoring will prefer it over the page chrome around it.";

/** Handle one /extract/ request. Returns false for an unknown path. */
export function handleExtractionFixture(url, res) {
  switch (url.pathname) {
    case "/extract/article":
      html(
        res,
        "Fixture article - Example News",
        `<header><nav><a href="/home">Home nav link</a> <a href="/world">World nav link</a></nav></header>
        <aside class="ad-slot">Buy now advertisement text</aside>
        <article>
          <h1>Fixture article</h1>
          <p class="byline">By Ada Lovelace</p>
          <p>${PARAGRAPH} See the <a href="/extract/related?x=1">related report</a> for more.</p>
          <h2>Details</h2>
          <p>${PARAGRAPH} It has <strong>strong words</strong> and <em>emphasis</em>.</p>
          <ul><li>First point</li><li>Second point</li></ul>
          <pre>const answer = 42;</pre>
          <div class="share-buttons">Share on social text</div>
          <div style="display:none">Hidden article text</div>
          <h2>Numbers</h2>
          <table><tr><th>Name</th><th>Value</th></tr><tr><td>alpha</td><td>1</td></tr></table>
          <p>${PARAGRAPH}</p>
        </article>
        <footer>Footer copyright text</footer>`,
        '<meta name="author" content="Ada Lovelace"><meta property="article:published_time" content="2026-10-31T09:00:00Z">',
      );
      return true;
    case "/extract/no-article":
      html(
        res,
        "Div soup",
        `<div id="menu"><a href="/a">Menu one</a> <a href="/b">Menu two</a> <a href="/c">Menu three</a></div>
        <div class="wrapper"><div class="story">
          <p>${PARAGRAPH}</p><p>${PARAGRAPH}</p><p>${PARAGRAPH}</p>
        </div>
        <div class="sidebar-links"><a href="/x">Sidebar link one</a> <a href="/y">Sidebar link two</a></div></div>`,
      );
      return true;
    case "/extract/long": {
      const sections = [];
      for (let i = 1; i <= 400; i += 1) {
        sections.push(
          `<h2>Section ${i}</h2><p>${PARAGRAPH} ${PARAGRAPH} ${PARAGRAPH}</p>`,
        );
      }
      html(
        res,
        "Long page",
        `<article><h1>Long page</h1>${sections.join("")}</article>`,
      );
      return true;
    }
    case "/extract/report.pdf": {
      const pdf = twoPagePdf();
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": pdf.length,
        "cache-control": "no-store",
      });
      res.end(pdf);
      return true;
    }
    case "/extract/tables":
      html(
        res,
        "Tables fixture",
        `<h1>Tables</h1>
        <table id="spans">
          <caption>Population</caption>
          <thead>
            <tr><th rowspan="2">City</th><th colspan="2">Population</th></tr>
            <tr><th>2010</th><th>2020</th></tr>
          </thead>
          <tbody>
            <tr><td>Springfield<sup class="reference">[1]</sup></td><td>1,234</td><td>1,500</td></tr>
            <tr><td></td><td></td><td></td></tr>
            <tr><td rowspan="2">Shelbyville</td><td>900</td><td>950</td></tr>
            <tr><td>901</td><td>951</td></tr>
          </tbody>
        </table>
        <table role="presentation"><tr><td>layout cell</td></tr></table>
        <div role="grid" aria-label="Orders" id="grid">
          <div role="row"><div role="columnheader">Order</div><div role="columnheader">Total</div></div>
          <div role="row"><div role="gridcell">A-1</div><div role="gridcell">$10.00</div></div>
          <div role="row"><div role="gridcell">A-2</div><div role="gridcell">$12.50</div></div>
        </div>`,
      );
      return true;
    case "/extract/structured":
      html(
        res,
        "Structured fixture",
        `<script type="application/ld+json">${JSON.stringify({
          "@context": "https://schema.org",
          "@graph": [
            { "@type": "Organization", name: "Example Org" },
            { "@type": "Article", headline: "Structured headline" },
          ],
        })}</script>
        <div itemscope itemtype="https://schema.org/Product">
          <span itemprop="name">Widget</span>
          <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
            <meta itemprop="price" content="9.99"><span itemprop="priceCurrency">USD</span>
          </div>
        </div>`,
        `<meta name="description" content="A structured fixture">
        <meta property="og:title" content="OG title">
        <meta property="og:image" content="https://example.test/a.png">
        <meta property="og:image" content="https://example.test/b.png">
        <meta name="twitter:card" content="summary">
        <link rel="canonical" href="/extract/structured?canonical=1">`,
      );
      return true;
    case "/extract/consent":
      html(res, "Consent fixture", consentBody(url.searchParams.get("kind")));
      return true;
    case "/extract/infinite":
      html(
        res,
        "Infinite list",
        `<h1>Infinite list</h1><div id="list"></div><div id="sentinel">loading</div>
        <script>
          const list = document.getElementById("list");
          let count = 0;
          function more() {
            if (count >= 100) { document.getElementById("sentinel").textContent = "end"; return; }
            for (let i = 0; i < 20; i += 1) {
              const item = document.createElement("div");
              item.className = "item";
              item.style.height = "60px";
              item.textContent = "item " + (++count);
              list.appendChild(item);
            }
          }
          more();
          new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) setTimeout(more, 150);
          }).observe(document.getElementById("sentinel"));
        </script>`,
      );
      return true;
    case "/extract/pages": {
      const n = Math.max(
        1,
        Math.min(3, Number(url.searchParams.get("n") || 1)),
      );
      const rows = [1, 2]
        .map((i) => `<tr><td>row ${n}.${i}</td><td>${n * 10 + i}</td></tr>`)
        .join("");
      html(
        res,
        `Page ${n}`,
        `<h1>Results page ${n}</h1>
        <table><tr><th>Name</th><th>Score</th></tr>${rows}</table>
        ${n < 3 ? `<a href="/extract/pages?n=${n + 1}">Next</a>` : '<span class="disabled">Next</span>'}`,
      );
      return true;
    }
    case "/extract/login":
      html(
        res,
        "Login fixture",
        `<form><label>User <input id="user" name="user"></label>
        <label>Password <input id="password" name="password" type="password"></label>
        <button type="button">Sign in</button></form>`,
      );
      return true;
    case "/extract/tall":
      html(
        res,
        "Tall page",
        `<div style="height:9000px;background:linear-gradient(#e33,#33e)">tall</div>`,
      );
      return true;
    default:
      return false;
  }
}

function consentBody(kind) {
  const article = `<main><h1>Consent fixture</h1><p>${PARAGRAPH}</p></main>
    <script>
      window.__consent = "unset";
      function choose(value) {
        window.__consent = value;
        for (const element of document.querySelectorAll("[data-banner]")) element.style.display = "none";
      }
    </script>`;
  switch (kind) {
    case "onetrust":
      return `${article}
        <div id="onetrust-banner-sdk" data-banner>
          <p>We use cookies to improve your experience.</p>
          <button id="onetrust-accept-btn-handler" onclick="choose('accepted')">Accept All Cookies</button>
          <button id="onetrust-reject-all-handler" onclick="choose('rejected')">Reject All</button>
        </div>`;
    case "cookiebot":
      return `${article}
        <div id="CybotCookiebotDialog" data-banner>
          <p>This website uses cookies</p>
          <button id="CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll" onclick="choose('accepted')">Allow all</button>
          <button id="CybotCookiebotDialogBodyButtonDecline" onclick="choose('rejected')">Deny</button>
        </div>`;
    case "generic":
      return `${article}
        <div role="dialog" class="privacy-popup" data-banner>
          <p>We and our partners use cookies for personalised ads.</p>
          <button onclick="choose('accepted')">Accept all</button>
          <button onclick="choose('rejected')">Only necessary cookies</button>
        </div>`;
    case "late":
      return `${article}
        <script>
          setTimeout(() => {
            const banner = document.createElement("div");
            banner.id = "onetrust-banner-sdk";
            banner.setAttribute("data-banner", "");
            banner.innerHTML = '<p>Cookies</p><button id="onetrust-reject-all-handler">Reject All</button>';
            banner.querySelector("button").onclick = () => choose("rejected");
            document.body.appendChild(banner);
          }, 400);
        </script>`;
    case "accept-only":
      return `${article}
        <div class="cookie-notice" data-banner>
          <p>This site uses cookies.</p>
          <button onclick="choose('accepted')">Accept</button>
        </div>`;
    default:
      return article;
  }
}

function html(res, title, body, head = "") {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`,
  );
}

/**
 * A small two-page PDF with compressed content streams, built by hand so
 * the suite has no binary fixture to keep in sync.
 */
export function twoPagePdf() {
  const pageText = [
    "BT /F1 18 Tf 72 720 Td (Quarterly report) Tj 0 -24 Td /F1 12 Tf (Revenue grew in the first quarter.) Tj ET",
    "BT /F1 12 Tf 72 720 Td (Second page text) Tj 0 -16 Td [(Costs ) -300 (fell.)] TJ ET",
  ];
  const objects = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] =
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 /Resources << /Font << /F1 7 0 R >> >> >>";
  const streams = {};
  pageText.forEach((text, i) => {
    const pageId = 3 + i * 2;
    const contentId = pageId + 1;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R >>`;
    streams[contentId] = deflateSync(Buffer.from(text, "latin1"));
  });
  objects[7] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[8] = "<< /Title (Fixture report) /Author (Ego Fixture) >>";
  const parts = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [];
  let length = parts[0].length;
  for (let id = 1; id <= 8; id += 1) {
    offsets[id] = length;
    let chunk;
    if (streams[id]) {
      chunk = Buffer.concat([
        Buffer.from(
          `${id} 0 obj\n<< /Length ${streams[id].length} /Filter /FlateDecode >>\nstream\n`,
          "latin1",
        ),
        streams[id],
        Buffer.from("\nendstream\nendobj\n", "latin1"),
      ]);
    } else {
      chunk = Buffer.from(`${id} 0 obj\n${objects[id]}\nendobj\n`, "latin1");
    }
    parts.push(chunk);
    length += chunk.length;
  }
  const xref = [`xref\n0 9\n0000000000 65535 f \n`];
  for (let id = 1; id <= 8; id += 1) {
    xref.push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  }
  xref.push(
    `trailer\n<< /Size 9 /Root 1 0 R /Info 8 0 R >>\nstartxref\n${length}\n%%EOF\n`,
  );
  parts.push(Buffer.from(xref.join(""), "latin1"));
  return Buffer.concat(parts);
}
