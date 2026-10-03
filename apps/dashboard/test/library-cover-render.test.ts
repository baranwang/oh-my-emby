import { describe, it, expect, vi } from "vitest";
import { orderPosters } from "../src/modules/libraries/covers/template.js";
import { imageDimensions, backgroundFromPixels } from "../src/modules/libraries/covers/assets.js";
import {
  loadCoverImage,
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
    expect(orderPosters(["a", "b", "c", "d"])).toEqual([
      "c",
      "a",
      "a",
      "d",
      "b",
      "b",
      "a",
      "d",
      "c",
    ]);
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
  it("matches Python red fallback and HLS-to-RGB truncation", () => {
    expect(backgroundFromPixels(new Uint8ClampedArray([100, 100, 100, 255]))).toBe(
      "rgb(107, 55, 55)",
    );
    expect(backgroundFromPixels(new Uint8ClampedArray([255, 0, 0, 255]))).toBe("rgb(107, 55, 55)");
  });
  it.each([
    {
      pixels: [
        [255, 0, 15],
        [255, 15, 0],
      ],
      expected: "rgb(107, 55, 55)",
    },
    {
      pixels: [
        [255, 255, 0],
        [255, 255, 0],
        [0, 0, 255],
      ],
      expected: "rgb(107, 107, 55)",
    },
    {
      pixels: [
        [120, 125, 122],
        [0, 150, 255],
      ],
      expected: "rgb(55, 86, 107)",
    },
    {
      pixels: [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 0, 0],
      ],
      expected: "rgb(107, 55, 55)",
    },
  ])("matches Python colorsys output for $pixels", ({ pixels, expected }) => {
    expect(
      backgroundFromPixels(new Uint8ClampedArray(pixels.flatMap((rgb) => [...rgb, 255]))),
    ).toBe(expected);
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
  it("revokes a pending image URL and removes handlers on abort", async () => {
    const revoke = vi.fn();
    const pending: { src: string; onload: (() => void) | null; onerror: (() => void) | null } = {
      src: "",
      onload: null,
      onerror: null,
    };
    vi.stubGlobal("URL", { createObjectURL: () => "blob:cover", revokeObjectURL: revoke });
    vi.stubGlobal("Image", function ImageFixture() {
      return pending;
    });
    try {
      const controller = new AbortController();
      const loaded = loadCoverImage(new Blob(["image"]), controller.signal);
      controller.abort();
      await expect(loaded).rejects.toMatchObject({ name: "AbortError" });
      expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:cover");
      expect(pending?.src).toBe("");
      expect(pending?.onload).toBeNull();
      expect(pending?.onerror).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
