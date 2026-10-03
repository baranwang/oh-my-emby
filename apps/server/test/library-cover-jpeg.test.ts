import { describe, expect, it } from "vitest";
import { validateLibraryCoverJpeg } from "../src/core/library-cover-jpeg.js";
export const jpeg = (width = 1920, height = 1080, marker = 0xc0) =>
  Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    marker,
    0,
    17,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    3,
    1,
    0x11,
    0,
    2,
    0x11,
    0,
    3,
    0x11,
    0,
    0xff,
    0xda,
    0,
    8,
    1,
    1,
    0,
    0,
    63,
    0,
    0,
    0xff,
    0xd9,
  ]);
describe("cover JPEG validation", () => {
  it.each([0xc0, 0xc2])("accepts expected dimensions with SOF %i", (m) =>
    expect(validateLibraryCoverJpeg(jpeg(1920, 1080, m))).toEqual({ width: 1920, height: 1080 }),
  );
  it.each([
    new Uint8Array(512001),
    jpeg(100, 100),
    jpeg().slice(0, 10),
    new Uint8Array([255, 216, 255, 224, 0, 1]),
    new Uint8Array([255, 216, 255, 217]),
  ])("rejects oversized, wrong-sized or truncated JPEG", (b) =>
    expect(() => validateLibraryCoverJpeg(b)).toThrow(),
  );
});
