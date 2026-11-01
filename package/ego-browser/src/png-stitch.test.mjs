import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

import {
  decodePng,
  encodePng,
  stitchPngsVertically,
} from "../dist/src/png-stitch.js";

function image(width, height, fill) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < rgba.length; i += 1) rgba[i] = (fill + i) & 0xff;
  return { width, height, rgba };
}

test("encodePng and decodePng round-trip RGBA pixels", () => {
  const original = image(5, 3, 7);
  const decoded = decodePng(encodePng(original));
  assert.equal(decoded.width, 5);
  assert.equal(decoded.height, 3);
  assert.deepEqual(decoded.rgba, original.rgba);
});

test("decodePng reads RGB images with every filter type", () => {
  // Hand-build a 2x5 RGB PNG whose rows use filters 0..4.
  const width = 2;
  const rows = [
    [0, 10, 20, 30, 40, 50, 60],
    [1, 1, 2, 3, 4, 5, 6],
    [2, 1, 1, 1, 1, 1, 1],
    [3, 5, 5, 5, 5, 5, 5],
    [4, 2, 2, 2, 2, 2, 2],
  ];
  const raw = Buffer.from(rows.flat());
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(rows.length, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const decoded = decodePng(png);
  // Unfilter by hand to get the expected RGB rows.
  const expected = [];
  let prev = new Array(6).fill(0);
  for (const [filter, ...bytes] of rows) {
    const out = [];
    for (let x = 0; x < 6; x += 1) {
      const a = x >= 3 ? out[x - 3] : 0;
      const b = prev[x];
      const c = x >= 3 ? prev[x - 3] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter];
      out.push((bytes[x] + predictor) & 0xff);
    }
    expected.push(out);
    prev = out;
  }
  const rgba = [];
  for (const row of expected) {
    for (let x = 0; x < 6; x += 3)
      rgba.push(row[x], row[x + 1], row[x + 2], 255);
  }
  assert.deepEqual([...decoded.rgba], rgba);
});

test("stitchPngsVertically stacks images and pads narrow ones with white", () => {
  const top = image(4, 2, 1);
  const bottom = image(3, 1, 9);
  const stitched = decodePng(
    stitchPngsVertically([encodePng(top), encodePng(bottom)]),
  );
  assert.equal(stitched.width, 4);
  assert.equal(stitched.height, 3);
  assert.deepEqual(stitched.rgba.subarray(0, 32), top.rgba);
  assert.deepEqual(stitched.rgba.subarray(32, 44), bottom.rgba);
  assert.deepEqual([...stitched.rgba.subarray(44, 48)], [255, 255, 255, 255]);
});
