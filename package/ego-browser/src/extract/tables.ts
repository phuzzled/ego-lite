/**
 * page.tables(): HTML tables and ARIA grids as JSON rows and CSV.
 *
 * `extractTables` runs inside the page. It expands rowspan and colspan into
 * a full grid, joins multi-row headers ("Population / 2020"), drops empty
 * spacer rows and repeated header rows, and strips footnote markers and edit
 * links from cell text. Numbers stay text ("1,234"), exactly as shown.
 */

export type TablesOptions = {
  selector?: string;
  index?: number;
  saveAs?: string;
  csv?: boolean;
  includeHidden?: boolean;
};

export type ExtractedTable = {
  index: number;
  caption?: string;
  selector: string;
  kind: "table" | "grid";
  headers: string[];
  rows: Array<Record<string, string>>;
  rowCount: number;
  csv?: string;
};

/** Quote one CSV field when it needs it (RFC 4180). */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) || /^\s|\s$/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

/** CSV text for one extracted table, header line first. */
export function tableToCsv(table: {
  headers: string[];
  rows: Array<Record<string, string>>;
}): string {
  const lines = [table.headers.map(csvField).join(",")];
  for (const row of table.rows) {
    lines.push(table.headers.map((h) => csvField(row[h] ?? "")).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Give repeated or empty header names a unique form. */
export function uniqueHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((header, i) => {
    const base = header.trim() || `Column ${i + 1}`;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

/**
 * Turn a grid of cell texts into headers and keyed rows. `headerRows` is how
 * many leading rows are headers. Exported for unit tests.
 */
export function gridToRows(
  grid: string[][],
  headerRows: number,
): { headers: string[]; rows: Array<Record<string, string>> } {
  const width = Math.max(0, ...grid.map((row) => row.length));
  const filled = grid.map((row) => [
    ...row,
    ...Array(Math.max(0, width - row.length)).fill(""),
  ]);
  const head = filled.slice(0, headerRows);
  let headers: string[] = [];
  for (let col = 0; col < width; col += 1) {
    const parts: string[] = [];
    for (const row of head) {
      const value = row[col];
      if (value && parts[parts.length - 1] !== value) parts.push(value);
    }
    headers.push(parts.join(" / "));
  }
  if (headerRows === 0) {
    headers = headers.map((_h, i) => `Column ${i + 1}`);
  }
  headers = uniqueHeaders(headers);
  const headerKey = head.length ? head[head.length - 1].join("\u0001") : "";
  const rows: Array<Record<string, string>> = [];
  for (const row of filled.slice(headerRows)) {
    if (row.every((cell) => !cell)) continue;
    if (headerKey && row.join("\u0001") === headerKey) continue;
    const record: Record<string, string> = {};
    headers.forEach((header, i) => {
      record[header] = row[i] ?? "";
    });
    rows.push(record);
  }
  return { headers, rows };
}

/**
 * Runs in the page. Self-contained. Returns raw grids; Node turns them into
 * rows with gridToRows (sent as source with this function).
 */
export function extractTables(options: {
  selector?: string;
  includeHidden?: boolean;
}): any {
  const doc = document;
  const NOISE =
    "sup.reference, .mw-editsection, .sortkey, .mw-collapsible-toggle, .navbar, style, script, noscript";
  // Wikipedia-style boxes that are navigation or notices, not data.
  const SKIP_TABLE =
    ".navbox, .navbox-inner, .navbox-subgroup, .vertical-navbox, .ambox, .mbox-small, .metadata, .sidebar, .toc, #toc";

  function cellText(cell: Element): string {
    let text: string;
    // A collapsed row has no layout, so innerText would be empty: read the
    // DOM text instead, and do the same when noise must be removed first.
    const rendered = cell.getClientRects().length > 0;
    if (!rendered || cell.querySelector(NOISE)) {
      const clone = cell.cloneNode(true) as Element;
      for (const noise of Array.from(clone.querySelectorAll(NOISE))) {
        noise.replaceWith(" ");
      }
      for (const block of Array.from(
        clone.querySelectorAll("br, p, li, div"),
      )) {
        block.before(" ");
        block.after(" ");
      }
      text = clone.textContent || "";
    } else {
      text = (cell as HTMLElement).innerText ?? cell.textContent ?? "";
    }
    return text
      .replace(/[\s\u00a0]+/g, " ")
      .replace(/ ([,.;:!?)\]])/g, "$1")
      .trim();
  }

  function visible(element: Element): boolean {
    if (options.includeHidden) return true;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function cssPath(element: Element): string {
    if (
      element.id &&
      doc.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1
    ) {
      return `#${CSS.escape(element.id)}`;
    }
    const parts: string[] = [];
    let node: Element | null = element;
    while (node && node !== doc.body && node !== doc.documentElement) {
      const current: Element = node;
      if (
        current.id &&
        doc.querySelectorAll(`#${CSS.escape(current.id)}`).length === 1
      ) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      const tag = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const same = Array.from(parent.children).filter(
        (child) => child.tagName === current.tagName,
      );
      parts.unshift(
        same.length === 1
          ? tag
          : `${tag}:nth-of-type(${same.indexOf(current) + 1})`,
      );
      node = parent;
    }
    return parts.join(" > ");
  }

  function htmlTable(table: HTMLTableElement) {
    const grid: string[][] = [];
    const isHeader: boolean[] = [];
    const occupied: boolean[][] = [];
    const rows = Array.from(table.rows);
    rows.forEach((row, r) => {
      grid[r] ||= [];
      occupied[r] ||= [];
      let col = 0;
      let allHeader = row.cells.length > 0;
      for (const cell of Array.from(row.cells)) {
        while (occupied[r][col]) col += 1;
        const text = cellText(cell);
        if (cell.tagName !== "TH") allHeader = false;
        const rowSpan = Math.max(1, Math.min(cell.rowSpan || 1, 1000));
        const colSpan = Math.max(1, Math.min(cell.colSpan || 1, 1000));
        for (let dr = 0; dr < rowSpan && r + dr < rows.length; dr += 1) {
          grid[r + dr] ||= [];
          occupied[r + dr] ||= [];
          for (let dc = 0; dc < colSpan; dc += 1) {
            grid[r + dr][col + dc] = text;
            occupied[r + dr][col + dc] = true;
          }
        }
        col += colSpan;
      }
      isHeader[r] =
        allHeader ||
        (row.parentElement?.tagName === "THEAD" && row.cells.length > 0);
    });
    let headerRows = 0;
    while (headerRows < isHeader.length && isHeader[headerRows]) {
      headerRows += 1;
    }
    for (let r = 0; r < grid.length; r += 1) {
      for (let c = 0; c < grid[r].length; c += 1) {
        if (grid[r][c] === undefined) grid[r][c] = "";
      }
    }
    return {
      grid,
      headerRows,
      caption: table.caption ? cellText(table.caption) : undefined,
    };
  }

  function ariaGrid(element: Element) {
    const rows = Array.from(element.querySelectorAll('[role="row"]')).filter(
      (row) =>
        row.closest('[role="grid"], [role="table"], [role="treegrid"]') ===
        element,
    );
    const grid: string[][] = [];
    let headerRows = 0;
    let headerDone = false;
    for (const row of rows) {
      const cells = Array.from(
        row.querySelectorAll(
          '[role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]',
        ),
      ).filter((cell) => cell.closest('[role="row"]') === row);
      if (cells.length === 0) continue;
      const allHeader = cells.every(
        (cell) => cell.getAttribute("role") === "columnheader",
      );
      if (allHeader && !headerDone) headerRows += 1;
      else headerDone = true;
      grid.push(cells.map(cellText));
    }
    const labelId = element.getAttribute("aria-labelledby");
    const caption =
      element.getAttribute("aria-label") ||
      (labelId
        ? doc.getElementById(labelId)?.textContent?.trim()
        : undefined) ||
      undefined;
    return { grid, headerRows, caption };
  }

  let candidates: Element[];
  if (options.selector) {
    try {
      candidates = Array.from(doc.querySelectorAll(options.selector));
    } catch {
      return { error: `invalid CSS selector: ${options.selector}` };
    }
    // A selector may point at a wrapper; use the tables inside it.
    candidates = candidates.flatMap((element) =>
      element.matches('table, [role="grid"], [role="table"], [role="treegrid"]')
        ? [element]
        : Array.from(
            element.querySelectorAll(
              'table, [role="grid"], [role="table"], [role="treegrid"]',
            ),
          ),
    );
  } else {
    candidates = Array.from(
      doc.querySelectorAll(
        'table, [role="grid"], [role="table"], [role="treegrid"]',
      ),
    );
  }
  const tables: any[] = [];
  const seen = new Set<Element>();
  for (const element of candidates) {
    if (seen.has(element)) continue;
    seen.add(element);
    const role = element.getAttribute("role");
    if (role === "presentation" || role === "none") continue;
    if (!options.selector && element.closest(SKIP_TABLE)) continue;
    if (!options.selector && !visible(element)) continue;
    const isTable = element.tagName === "TABLE";
    const data = isTable
      ? htmlTable(element as HTMLTableElement)
      : ariaGrid(element);
    const nonEmpty = data.grid.filter((row) => row.some((cell) => cell));
    // Layout tables: a single cell, or a single row with no header.
    if (!options.selector && nonEmpty.length < 2 && data.headerRows === 0) {
      continue;
    }
    tables.push({
      kind: isTable ? "table" : "grid",
      selector: cssPath(element),
      ...data,
    });
  }
  return { tables };
}
