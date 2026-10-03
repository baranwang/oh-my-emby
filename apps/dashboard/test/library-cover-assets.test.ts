import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareLibraryCoverAssets } from "../src/modules/libraries/covers/assets";
const release = vi.hoisted(() => vi.fn());
vi.mock("../src/modules/libraries/covers/render", () => ({
  loadCoverImage: async () => ({ image: { naturalWidth: 384, naturalHeight: 576 }, release }),
}));
const preparation = {
  candidates: Array.from({ length: 18 }, (_, index) => ({
    index,
    url: `/api/dashboard/libraries/lib/cover/assets/token/${index}`,
  })),
} as any;
const png = () => {
  const b = new Uint8Array(24);
  b.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const v = new DataView(b.buffer);
  v.setUint32(16, 384);
  v.setUint32(20, 576);
  return b;
};
beforeEach(() => {
  release.mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray([10, 10, 10, 255]) }),
  } as any);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,a");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("cover assets", () => {
  it("stops the entire preparation after expired authentication", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(prepareLibraryCoverAssets(preparation)).rejects.toMatchObject({
      name: "CoverSessionExpired",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("skips failed posters, bounds concurrency at two and stops after nine successes", async () => {
    let active = 0,
      maximum = 0,
      calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const current = calls++;
        maximum = Math.max(maximum, ++active);
        await new Promise((r) => setTimeout(r, 0));
        active--;
        return current < 2 ? new Response(null, { status: 502 }) : new Response(png());
      }),
    );
    expect((await prepareLibraryCoverAssets(preparation)).posters).toHaveLength(9);
    expect(maximum).toBe(2);
    expect(calls).toBe(11);
    expect(release).toHaveBeenCalledTimes(9);
  });
  it("fails if no poster can be decoded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    );
    await expect(prepareLibraryCoverAssets(preparation)).rejects.toThrow("No usable posters");
    expect(release).not.toHaveBeenCalled();
  });
  it("takes background color from poster number one before layout ordering", async () => {
    let number = 0;
    const colors = [
      new Uint8ClampedArray([255, 0, 0, 255]),
      new Uint8ClampedArray([0, 255, 0, 255]),
      new Uint8ClampedArray([0, 0, 255, 255]),
    ];
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(() => {
      const color = colors[number++ % 3]!;
      return { drawImage: vi.fn(), getImageData: () => ({ data: color }) } as any;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(png())),
    );
    const result = await prepareLibraryCoverAssets({
      ...preparation,
      candidates: preparation.candidates.slice(0, 3),
    });
    expect(result.background).toBe("rgb(107, 55, 55)");
  });
});
