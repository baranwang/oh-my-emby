import { describe, it, expect } from "vitest";
import { orderPosters } from "../src/modules/libraries/covers/template.js";
import { imageDimensions, backgroundFromPixels } from "../src/modules/libraries/covers/assets.js";
import {
  fitCoverTitle,
  encodeCoverJpeg,
  SYSTEM_FONT_STACK,
} from "../src/modules/libraries/covers/render.js";
describe("browser cover rendering", () => {
  it("uses reference order and repeats scarce posters", () => {
    expect(orderPosters(["1", "2", "3", "4", "5", "6", "7", "8", "9"])).toEqual([
      "3",
      "1",
      "5",
      "4",
      "2",
      "6",
      "9",
      "8",
      "7",
    ]);
    expect(orderPosters(["a"])).toEqual(Array(9).fill("a"));
    expect(() => orderPosters([])).toThrow();
  });
  it("rejects unrecognized dimensions before image decode", () => {
    expect(() => imageDimensions(new Uint8Array([1, 2, 3]))).toThrow();
    const b = new Uint8Array(24);
    b.set([137, 80, 78, 71, 13, 10, 26, 10]);
    new DataView(b.buffer).setUint32(16, 50000);
    new DataView(b.buffer).setUint32(20, 50000);
    expect(() => imageDimensions(b)).toThrow();
  });
  it("uses a dark fallback for grayscale and circular red hue", () => {
    expect(backgroundFromPixels(new Uint8ClampedArray([100, 100, 100, 255]))).toBe("#243447");
    expect(backgroundFromPixels(new Uint8ClampedArray([255, 0, 0, 255]))).toBe("hsl(0, 32%, 32%)");
  });
  it("fits mixed titles with system font, not downloaded fonts", () => {
    const ctx = { font: "", measureText: (s: string) => ({ width: [...s].length * 200 }) } as any;
    const title = fitCoverTitle(ctx, "电影😀剧集很长", 600);
    expect(title.text.endsWith("…")).toBe(true);
    expect(ctx.font).toContain("system-ui");
    expect(SYSTEM_FONT_STACK).not.toContain("Lexend");
  });
  it("reduces JPEG quality until within cap and refuses oversized result", async () => {
    const qualities: number[] = [];
    const canvas = {
      toBlob: (cb: any, _: string, q: number) => {
        qualities.push(q);
        cb(new Blob([new Uint8Array(q > 0.65 ? 512001 : 100)]));
      },
    } as any;
    expect((await encodeCoverJpeg(canvas)).size).toBe(100);
    expect(qualities.length).toBeGreaterThan(1);
    canvas.toBlob = (cb: any) => cb(new Blob([new Uint8Array(512001)]));
    await expect(encodeCoverJpeg(canvas)).rejects.toThrow();
    canvas.toBlob = (cb: any) => cb(null);
    await expect(encodeCoverJpeg(canvas)).rejects.toThrow();
  });
});
