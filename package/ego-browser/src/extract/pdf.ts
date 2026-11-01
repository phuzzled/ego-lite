/**
 * Text from a PDF, with no external library.
 *
 * The SDK ships as one file that the browser app embeds, so pdf.js (about
 * 1 MB, and loaded as separate chunks) does not fit. This reader covers the
 * PDFs agents meet most: text-based documents with Flate-compressed content
 * streams, object streams, Type1/TrueType/Type0 fonts and ToUnicode maps. It
 * reads pages in order through the page tree and follows form XObjects.
 *
 * It does not decrypt, run OCR on scanned pages, or lay text out exactly;
 * it puts each text line on its own line and separates words by spacing.
 */
import { inflateSync, inflateRawSync } from "node:zlib";

export type PdfPage = { n: number; text: string };
export type PdfText = {
  pages: PdfPage[];
  info: { title?: string; author?: string; pageCount: number };
  /** Set when pages had no extractable text (scanned images, encryption). */
  warning?: string;
};

type PdfRef = { ref: number };
type PdfName = { name: string };
type PdfValue =
  | number
  | boolean
  | null
  | string
  | PdfName
  | PdfRef
  | PdfValue[]
  | PdfDict
  | PdfStream;
type PdfDict = { dict: Map<string, PdfValue> };
type PdfStream = { dict: Map<string, PdfValue>; data: Buffer };

const MAX_FORM_DEPTH = 6;

class Lexer {
  pos = 0;
  constructor(
    readonly src: Buffer,
    start = 0,
  ) {
    this.pos = start;
  }

  skipSpace(): void {
    const src = this.src;
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (c === 0x25) {
        // % comment to end of line
        while (
          this.pos < src.length &&
          src[this.pos] !== 0x0a &&
          src[this.pos] !== 0x0d
        ) {
          this.pos += 1;
        }
      } else if (
        c === 0x20 ||
        c === 0x0a ||
        c === 0x0d ||
        c === 0x09 ||
        c === 0x0c ||
        c === 0x00
      ) {
        this.pos += 1;
      } else {
        break;
      }
    }
  }

  /** Next token: a value, or { op } for a bare keyword. */
  next(): PdfValue | { op: string } | undefined {
    this.skipSpace();
    const src = this.src;
    if (this.pos >= src.length) return undefined;
    const c = src[this.pos];
    if (c === 0x2f) return { name: this.readName() };
    if (c === 0x28) return this.readLiteralString();
    if (c === 0x3c) {
      if (src[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return this.readDict();
      }
      return this.readHexString();
    }
    if (c === 0x5b) {
      this.pos += 1;
      const items: PdfValue[] = [];
      while (true) {
        this.skipSpace();
        if (this.pos >= src.length) break;
        if (src[this.pos] === 0x5d) {
          this.pos += 1;
          break;
        }
        const item = this.value();
        if (item === undefined) break;
        items.push(item);
      }
      return items;
    }
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
      this.pos += 1;
      return { op: String.fromCharCode(c) };
    }
    const word = this.readWord();
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return { op: word };
  }

  /** A value, resolving `n g R` into a reference. */
  value(): PdfValue | undefined {
    const token = this.next();
    if (token === undefined) return undefined;
    if (typeof token === "number" && Number.isInteger(token)) {
      const save = this.pos;
      const generation = this.next();
      if (typeof generation === "number") {
        const r = this.next();
        if (r && typeof r === "object" && "op" in r && r.op === "R") {
          return { ref: token };
        }
      }
      this.pos = save;
      return token;
    }
    if (token && typeof token === "object" && "op" in token) return null;
    return token as PdfValue;
  }

  readDict(): PdfDict {
    const dict = new Map<string, PdfValue>();
    while (true) {
      this.skipSpace();
      if (this.pos >= this.src.length) break;
      if (this.src[this.pos] === 0x3e && this.src[this.pos + 1] === 0x3e) {
        this.pos += 2;
        break;
      }
      const key = this.next();
      if (!key || typeof key !== "object" || !("name" in key)) {
        if (key === undefined) break;
        continue;
      }
      const value = this.value();
      if (value === undefined) break;
      dict.set((key as PdfName).name, value);
    }
    return { dict };
  }

  readWord(): string {
    const start = this.pos;
    const src = this.src;
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (
        c <= 0x20 ||
        c === 0x2f ||
        c === 0x28 ||
        c === 0x29 ||
        c === 0x3c ||
        c === 0x3e ||
        c === 0x5b ||
        c === 0x5d ||
        c === 0x7b ||
        c === 0x7d ||
        c === 0x25
      ) {
        break;
      }
      this.pos += 1;
    }
    if (this.pos === start) this.pos += 1;
    return src.toString("latin1", start, this.pos);
  }

  readName(): string {
    this.pos += 1;
    return this.readWord().replace(/#([0-9a-fA-F]{2})/g, (_m, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  }

  readLiteralString(): string {
    const src = this.src;
    this.pos += 1;
    let depth = 1;
    const bytes: number[] = [];
    while (this.pos < src.length) {
      const c = src[this.pos++];
      if (c === 0x5c) {
        const n = src[this.pos++];
        if (n === 0x6e) bytes.push(0x0a);
        else if (n === 0x72) bytes.push(0x0d);
        else if (n === 0x74) bytes.push(0x09);
        else if (n === 0x62) bytes.push(0x08);
        else if (n === 0x66) bytes.push(0x0c);
        else if (n === 0x0d) {
          if (src[this.pos] === 0x0a) this.pos += 1;
        } else if (n === 0x0a) {
          // line continuation
        } else if (n >= 0x30 && n <= 0x37) {
          let octal = n - 0x30;
          for (let i = 0; i < 2; i += 1) {
            const d = src[this.pos];
            if (d >= 0x30 && d <= 0x37) {
              octal = octal * 8 + (d - 0x30);
              this.pos += 1;
            } else break;
          }
          bytes.push(octal & 0xff);
        } else if (n !== undefined) bytes.push(n);
      } else if (c === 0x28) {
        depth += 1;
        bytes.push(c);
      } else if (c === 0x29) {
        depth -= 1;
        if (depth === 0) break;
        bytes.push(c);
      } else {
        bytes.push(c);
      }
    }
    return Buffer.from(bytes).toString("latin1");
  }

  readHexString(): string {
    const src = this.src;
    this.pos += 1;
    let hex = "";
    while (this.pos < src.length && src[this.pos] !== 0x3e) {
      const c = String.fromCharCode(src[this.pos++]);
      if (/[0-9a-fA-F]/.test(c)) hex += c;
    }
    this.pos += 1;
    if (hex.length % 2) hex += "0";
    return Buffer.from(hex, "hex").toString("latin1");
  }
}

function isName(value: unknown, name?: string): value is PdfName {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    "name" in (value as object) &&
    (name === undefined || (value as PdfName).name === name)
  );
}

function isRef(value: unknown): value is PdfRef {
  return (
    Boolean(value) && typeof value === "object" && "ref" in (value as object)
  );
}

function isDict(value: unknown): value is PdfDict {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as PdfDict).dict instanceof Map
  );
}

function isStream(value: unknown): value is PdfStream {
  return isDict(value) && Buffer.isBuffer((value as PdfStream).data);
}

class PdfDocument {
  readonly objects = new Map<number, PdfValue>();
  #offsets = new Map<number, number>();
  #trailer: PdfDict = { dict: new Map() };

  constructor(readonly bytes: Buffer) {
    this.#scan();
  }

  /** Find every "n g obj" in the file; later definitions win (updates). */
  #scan(): void {
    const text = this.bytes.toString("latin1");
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      this.#offsets.set(Number(match[1]), match.index + match[0].length);
    }
    for (const trailer of text.matchAll(/trailer\s*<</g)) {
      const lexer = new Lexer(this.bytes, trailer.index! + trailer[0].length);
      const dict = lexer.readDict();
      for (const [key, value] of dict.dict) this.#trailer.dict.set(key, value);
    }
    // Cross-reference streams carry the trailer keys in their dictionary.
    for (const number of this.#offsets.keys()) {
      const value = this.get({ ref: number });
      if (isStream(value) && isName(value.dict.get("Type"), "XRef")) {
        for (const key of ["Root", "Info", "Encrypt"]) {
          if (value.dict.has(key) && !this.#trailer.dict.has(key)) {
            this.#trailer.dict.set(key, value.dict.get(key)!);
          }
        }
      }
    }
    // Objects packed into object streams.
    for (const number of [...this.#offsets.keys()]) {
      const value = this.get({ ref: number });
      if (isStream(value) && isName(value.dict.get("Type"), "ObjStm")) {
        this.#unpackObjectStream(value);
      }
    }
  }

  #unpackObjectStream(stream: PdfStream): void {
    const data = decodeStream(stream, this);
    if (!data) return;
    const count = Number(this.resolve(stream.dict.get("N")));
    const first = Number(this.resolve(stream.dict.get("First")));
    const header = new Lexer(data);
    const entries: Array<[number, number]> = [];
    for (let i = 0; i < count; i += 1) {
      const number = header.next();
      const offset = header.next();
      if (typeof number !== "number" || typeof offset !== "number") break;
      entries.push([number, offset]);
    }
    for (const [number, offset] of entries) {
      if (this.objects.has(number) || this.#offsets.has(number)) continue;
      const lexer = new Lexer(data, first + offset);
      const value = lexer.value();
      if (value !== undefined) this.objects.set(number, value);
    }
  }

  get trailer(): PdfDict {
    return this.#trailer;
  }

  get(ref: PdfRef): PdfValue | undefined {
    if (this.objects.has(ref.ref)) return this.objects.get(ref.ref);
    const offset = this.#offsets.get(ref.ref);
    if (offset === undefined) return undefined;
    const lexer = new Lexer(this.bytes, offset);
    let value = lexer.value() ?? null;
    lexer.skipSpace();
    if (
      isDict(value) &&
      this.bytes.toString("latin1", lexer.pos, lexer.pos + 6) === "stream"
    ) {
      let start = lexer.pos + 6;
      if (this.bytes[start] === 0x0d) start += 1;
      if (this.bytes[start] === 0x0a) start += 1;
      const length = value.dict.get("Length");
      let end = -1;
      if (typeof length === "number") {
        end = start + length;
        const after = this.bytes.toString("latin1", end, end + 20);
        if (!/^\s*endstream/.test(after)) end = -1;
      }
      if (end < 0) {
        end = this.bytes.indexOf("endstream", start, "latin1");
        if (end < 0) end = this.bytes.length;
      }
      value = { dict: value.dict, data: this.bytes.subarray(start, end) };
    }
    this.objects.set(ref.ref, value);
    return value;
  }

  resolve(value: PdfValue | undefined, depth = 0): PdfValue | undefined {
    if (isRef(value) && depth < 20) {
      return this.resolve(this.get(value), depth + 1);
    }
    return value;
  }

  dictOf(value: PdfValue | undefined): Map<string, PdfValue> | undefined {
    const resolved = this.resolve(value);
    return isDict(resolved) ? resolved.dict : undefined;
  }
}

/** Decode a stream's data through its filters, or undefined if unsupported. */
function decodeStream(stream: PdfStream, doc: PdfDocument): Buffer | undefined {
  const filter = doc.resolve(stream.dict.get("Filter"));
  const filters = Array.isArray(filter) ? filter : filter ? [filter] : [];
  let data = stream.data;
  for (const entry of filters) {
    const name = isName(entry) ? entry.name : "";
    if (name === "FlateDecode" || name === "Fl") {
      try {
        data = inflateSync(data);
      } catch {
        try {
          data = inflateRawSync(data.subarray(2));
        } catch {
          return undefined;
        }
      }
    } else if (name === "ASCIIHexDecode" || name === "AHx") {
      const hex = data.toString("latin1").replace(/[^0-9a-fA-F]/g, "");
      data = Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex");
    } else if (name === "ASCII85Decode" || name === "A85") {
      data = decodeAscii85(data);
    } else {
      return undefined;
    }
  }
  const params = doc.dictOf(stream.dict.get("DecodeParms"));
  const predictor = Number(doc.resolve(params?.get("Predictor")) ?? 1);
  if (predictor >= 10) {
    const columns = Number(doc.resolve(params?.get("Columns")) ?? 1);
    data = undoPngPredictor(data, columns);
  }
  return data;
}

function decodeAscii85(data: Buffer): Buffer {
  const text = data
    .toString("latin1")
    .replace(/^<~/, "")
    .replace(/~>[\s\S]*$/, "")
    .replace(/\s+/g, "");
  const out: number[] = [];
  let group: number[] = [];
  for (const char of text) {
    if (char === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(char.charCodeAt(0) - 33);
    if (group.length === 5) {
      let value = 0;
      for (const digit of group) value = value * 85 + digit;
      out.push(
        (value >>> 24) & 255,
        (value >>> 16) & 255,
        (value >>> 8) & 255,
        value & 255,
      );
      group = [];
    }
  }
  if (group.length > 1) {
    const missing = 5 - group.length;
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const bytes = [
      (value >>> 24) & 255,
      (value >>> 16) & 255,
      (value >>> 8) & 255,
      value & 255,
    ];
    out.push(...bytes.slice(0, 4 - missing));
  }
  return Buffer.from(out);
}

function undoPngPredictor(data: Buffer, columns: number): Buffer {
  const rowLength = columns + 1;
  const rows = Math.floor(data.length / rowLength);
  const out = Buffer.alloc(rows * columns);
  const previous = Buffer.alloc(columns);
  for (let row = 0; row < rows; row += 1) {
    const type = data[row * rowLength];
    for (let i = 0; i < columns; i += 1) {
      const raw = data[row * rowLength + 1 + i];
      const left = i > 0 ? out[row * columns + i - 1] : 0;
      const up = previous[i];
      let value = raw;
      if (type === 1) value = raw + left;
      else if (type === 2) value = raw + up;
      else if (type === 3) value = raw + ((left + up) >> 1);
      else if (type === 4) {
        const upLeft = i > 0 ? previous[i - 1] : 0;
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      out[row * columns + i] = value & 255;
    }
    out.copy(previous, 0, row * columns, row * columns + columns);
  }
  return out;
}

/** A font's byte-to-text mapping. */
type FontDecoder = { bytes: 1 | 2; map: Map<number, string> };

// The printable part of WinAnsiEncoding that differs from Latin-1.
const WIN_ANSI: Record<number, string> = {
  0x80: "€",
  0x82: "‚",
  0x83: "ƒ",
  0x84: "„",
  0x85: "…",
  0x86: "†",
  0x87: "‡",
  0x88: "ˆ",
  0x89: "‰",
  0x8a: "Š",
  0x8b: "‹",
  0x8c: "Œ",
  0x8e: "Ž",
  0x91: "‘",
  0x92: "’",
  0x93: "“",
  0x94: "”",
  0x95: "•",
  0x96: "–",
  0x97: "—",
  0x98: "˜",
  0x99: "™",
  0x9a: "š",
  0x9b: "›",
  0x9c: "œ",
  0x9e: "ž",
  0x9f: "Ÿ",
};

// Glyph names used in /Differences that are worth mapping.
const GLYPH_NAMES: Record<string, string> = {
  space: " ",
  quoteright: "’",
  quoteleft: "‘",
  quotedblleft: "“",
  quotedblright: "”",
  endash: "–",
  emdash: "—",
  bullet: "•",
  fi: "fi",
  fl: "fl",
  ff: "ff",
  ffi: "ffi",
  ffl: "ffl",
  hyphen: "-",
  period: ".",
  comma: ",",
  colon: ":",
  semicolon: ";",
  parenleft: "(",
  parenright: ")",
  ellipsis: "…",
};

function parseToUnicode(data: Buffer): {
  map: Map<number, string>;
  bytes: 1 | 2;
} {
  const text = data.toString("latin1");
  const map = new Map<number, string>();
  let bytes: 1 | 2 = 1;
  const space = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (space && /<[0-9a-fA-F]{4}>/.test(space[1])) bytes = 2;
  const utf16 = (hex: string) => {
    const buffer = Buffer.from(
      hex.length % 4 ? hex.padStart(4, "0") : hex,
      "hex",
    );
    let out = "";
    for (let i = 0; i + 1 < buffer.length; i += 2) {
      out += String.fromCharCode(buffer.readUInt16BE(i));
    }
    return out;
  };
  for (const section of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of section[1].matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g,
    )) {
      map.set(parseInt(pair[1], 16), utf16(pair[2]));
    }
  }
  for (const section of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of section[1].matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g,
    )) {
      const low = parseInt(range[1], 16);
      const high = parseInt(range[2], 16);
      if (high - low > 0xffff) continue;
      if (range[3].startsWith("[")) {
        const targets = [...range[3].matchAll(/<([0-9a-fA-F]*)>/g)];
        targets.forEach((target, i) => map.set(low + i, utf16(target[1])));
      } else {
        const start = range[3].slice(1, -1);
        const base = utf16(start);
        const lastCode = base.charCodeAt(base.length - 1);
        for (let code = low; code <= high; code += 1) {
          map.set(
            code,
            base.slice(0, -1) + String.fromCharCode(lastCode + (code - low)),
          );
        }
      }
    }
  }
  return { map, bytes };
}

function fontDecoder(
  font: Map<string, PdfValue> | undefined,
  doc: PdfDocument,
): FontDecoder {
  const map = new Map<number, string>();
  if (!font) return { bytes: 1, map };
  const subtype = doc.resolve(font.get("Subtype"));
  let bytes: 1 | 2 = isName(subtype, "Type0") ? 2 : 1;
  const encoding = doc.resolve(font.get("Encoding"));
  if (bytes === 1) {
    for (let code = 0x20; code < 0x100; code += 1) {
      map.set(code, WIN_ANSI[code] ?? String.fromCharCode(code));
    }
    const differences = isDict(encoding)
      ? doc.resolve(encoding.dict.get("Differences"))
      : undefined;
    if (Array.isArray(differences)) {
      let code = 0;
      for (const item of differences) {
        const value = doc.resolve(item);
        if (typeof value === "number") code = value;
        else if (isName(value)) {
          const glyph = value.name;
          const mapped =
            GLYPH_NAMES[glyph] ??
            (/^uni([0-9A-F]{4})$/.exec(glyph)
              ? String.fromCharCode(parseInt(glyph.slice(3), 16))
              : glyph.length === 1
                ? glyph
                : undefined);
          if (mapped !== undefined) map.set(code, mapped);
          code += 1;
        }
      }
    }
  }
  const toUnicode = doc.resolve(font.get("ToUnicode"));
  if (isStream(toUnicode)) {
    const data = decodeStream(toUnicode, doc);
    if (data) {
      const parsed = parseToUnicode(data);
      if (parsed.map.size > 0) {
        if (isName(subtype, "Type0")) bytes = parsed.bytes;
        for (const [code, text] of parsed.map) map.set(code, text);
      }
    }
  }
  return { bytes, map };
}

function decodeText(raw: string, decoder: FontDecoder): string {
  let out = "";
  if (decoder.bytes === 2) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const code = (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1);
      out += decoder.map.get(code) ?? "";
    }
    return out;
  }
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    out += decoder.map.get(code) ?? (code >= 0x20 ? raw[i] : "");
  }
  return out;
}

/** Collects text runs and decides where lines and spaces go. */
class TextSink {
  lines: string[] = [];
  line = "";
  lastY: number | undefined;

  newLine(): void {
    const text = this.line.replace(/\s+/g, " ").trim();
    if (text) this.lines.push(text);
    this.line = "";
  }

  space(): void {
    if (this.line && !this.line.endsWith(" ")) this.line += " ";
  }

  moveTo(y: number): void {
    if (this.lastY !== undefined && Math.abs(y - this.lastY) > 1) {
      this.newLine();
    }
    this.lastY = y;
  }

  text(): string {
    this.newLine();
    // Rejoin words hyphenated across lines.
    return this.lines.join("\n").replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2");
  }
}

function runContent(
  data: Buffer,
  resources: Map<string, PdfValue> | undefined,
  doc: PdfDocument,
  sink: TextSink,
  depth: number,
): void {
  const fonts = doc.dictOf(resources?.get("Font"));
  const xobjects = doc.dictOf(resources?.get("XObject"));
  const decoders = new Map<string, FontDecoder>();
  let decoder: FontDecoder = { bytes: 1, map: new Map() };
  let leading = 0;
  let y = 0;
  const lexer = new Lexer(data);
  const operands: PdfValue[] = [];
  while (true) {
    const token = lexer.next();
    if (token === undefined) break;
    if (!(token && typeof token === "object" && "op" in token)) {
      operands.push(token as PdfValue);
      if (operands.length > 64) operands.shift();
      continue;
    }
    const op = token.op;
    switch (op) {
      case "BT":
        break;
      case "ET":
        break;
      case "Tf": {
        const fontName = operands[operands.length - 2];
        if (isName(fontName)) {
          if (!decoders.has(fontName.name)) {
            decoders.set(
              fontName.name,
              fontDecoder(doc.dictOf(fonts?.get(fontName.name)), doc),
            );
          }
          decoder = decoders.get(fontName.name)!;
        }
        break;
      }
      case "TL":
        leading = Number(operands.at(-1)) || 0;
        break;
      case "Td":
      case "TD": {
        const tx = Number(operands.at(-2)) || 0;
        const ty = Number(operands.at(-1)) || 0;
        if (op === "TD") leading = -ty;
        if (Math.abs(ty) > 0.5) {
          y += ty;
          sink.moveTo(y);
        } else if (tx > 0) sink.space();
        break;
      }
      case "Tm": {
        y = Number(operands.at(-1)) || 0;
        const before = sink.lastY;
        sink.moveTo(y);
        if (before !== undefined && Math.abs(y - before) <= 1) sink.space();
        break;
      }
      case "T*":
        y -= leading;
        sink.newLine();
        sink.lastY = y;
        break;
      case "Tj":
      case "'":
      case '"': {
        if (op !== "Tj") {
          y -= leading;
          sink.newLine();
          sink.lastY = y;
        }
        const raw = operands.at(-1);
        if (typeof raw === "string") sink.line += decodeText(raw, decoder);
        break;
      }
      case "TJ": {
        const items = operands.at(-1);
        if (Array.isArray(items)) {
          for (const item of items) {
            if (typeof item === "string") {
              sink.line += decodeText(item, decoder);
            } else if (typeof item === "number" && item < -200) {
              sink.space();
            }
          }
        }
        break;
      }
      case "Do": {
        const name = operands.at(-1);
        if (isName(name) && depth < MAX_FORM_DEPTH) {
          const form = doc.resolve(xobjects?.get(name.name));
          if (
            isStream(form) &&
            isName(doc.resolve(form.dict.get("Subtype")), "Form")
          ) {
            const content = decodeStream(form, doc);
            if (content) {
              runContent(
                content,
                doc.dictOf(form.dict.get("Resources")) ?? resources,
                doc,
                sink,
                depth + 1,
              );
            }
          }
        }
        break;
      }
      case "BI": {
        // Skip inline image data up to EI.
        const end = data.indexOf("EI", lexer.pos, "latin1");
        lexer.pos = end < 0 ? data.length : end + 2;
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
}

function collectPages(
  doc: PdfDocument,
  node: PdfValue | undefined,
  inherited: Map<string, PdfValue> | undefined,
  out: Array<{
    page: Map<string, PdfValue>;
    resources?: Map<string, PdfValue>;
  }>,
  seen: Set<unknown>,
): void {
  const resolved = doc.resolve(node);
  if (!isDict(resolved) || seen.has(resolved)) return;
  seen.add(resolved);
  const dict = resolved.dict;
  const resources = doc.dictOf(dict.get("Resources")) ?? inherited;
  const kids = doc.resolve(dict.get("Kids"));
  if (Array.isArray(kids)) {
    for (const kid of kids) collectPages(doc, kid, resources, out, seen);
    return;
  }
  out.push({ page: dict, resources });
}

function infoString(doc: PdfDocument, value: PdfValue | undefined) {
  const resolved = doc.resolve(value);
  if (typeof resolved !== "string" || !resolved) return undefined;
  if (resolved.startsWith("þÿ")) {
    let out = "";
    for (let i = 2; i + 1 < resolved.length; i += 2) {
      out += String.fromCharCode(
        (resolved.charCodeAt(i) << 8) | resolved.charCodeAt(i + 1),
      );
    }
    return out;
  }
  return resolved;
}

/** Extract text from PDF bytes, page by page. */
export function extractPdfText(bytes: Buffer | Uint8Array): PdfText {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.toString("latin1", 0, 1024).indexOf("%PDF-") < 0) {
    throw new Error("not a PDF: the data does not start with %PDF-");
  }
  const doc = new PdfDocument(buffer);
  const trailer = doc.trailer.dict;
  const infoDict = doc.dictOf(trailer.get("Info"));
  const info = {
    title: infoString(doc, infoDict?.get("Title")),
    author: infoString(doc, infoDict?.get("Author")),
  };
  if (trailer.has("Encrypt")) {
    return {
      pages: [],
      info: { ...info, pageCount: 0 },
      warning:
        "this PDF is encrypted; its text cannot be read without decrypting it. Open it in the browser and take a screenshot, or ask the user for an unencrypted copy.",
    };
  }
  const root = doc.dictOf(trailer.get("Root"));
  const found: Array<{
    page: Map<string, PdfValue>;
    resources?: Map<string, PdfValue>;
  }> = [];
  collectPages(doc, root?.get("Pages"), undefined, found, new Set());
  const pages: PdfPage[] = found.map(({ page, resources }, index) => {
    const sink = new TextSink();
    const contents = doc.resolve(page.get("Contents"));
    const parts = Array.isArray(contents) ? contents : [contents];
    const streams: Buffer[] = [];
    for (const part of parts) {
      const stream = doc.resolve(part);
      if (!isStream(stream)) continue;
      const data = decodeStream(stream, doc);
      if (data) streams.push(data);
    }
    // Content may be split across streams at any token boundary.
    runContent(
      Buffer.concat(streams.flatMap((s) => [s, Buffer.from("\n")])),
      resources,
      doc,
      sink,
      0,
    );
    return { n: index + 1, text: sink.text() };
  });
  const empty = pages.every((page) => !page.text.trim());
  return {
    pages,
    info: { ...info, pageCount: pages.length },
    ...(empty && pages.length > 0
      ? {
          warning:
            "no text found in this PDF; it may be scanned images. Take a screenshot of the page in the browser to read it.",
        }
      : {}),
  };
}

/** Markdown for a PDF: one section per page. */
export function pdfMarkdown(text: PdfText): string {
  const title = text.info.title ? `# ${text.info.title}\n\n` : "";
  return (
    title +
    text.pages.map((page) => `## Page ${page.n}\n\n${page.text}`).join("\n\n")
  );
}
