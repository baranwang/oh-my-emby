import type { LibraryCoverPreparation } from "@oh-my-emby/contracts";
import { loadCoverImage } from "./render.js";
export class CoverSessionExpired extends Error {
  constructor() {
    super("Session expired");
    this.name = "CoverSessionExpired";
  }
}
export function imageDimensions(b: Uint8Array): { width: number; height: number } {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let width = 0,
    height = 0;
  if (b.length >= 24 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (b[0] === 255 && b[1] === 216) {
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i++] !== 255) break;
      while (b[i] === 255) i++;
      const m = b[i++];
      if (m === 218 || m === 217) break;
      const len = (b[i]! << 8) | b[i + 1]!;
      if (len < 2 || i + len > b.length) break;
      if (m === 192 || m === 193 || m === 194) {
        if (len < 8) break;
        height = view.getUint16(i + 3);
        width = view.getUint16(i + 5);
        break;
      }
      i += len;
    }
  } else if (
    b.length >= 30 &&
    new TextDecoder().decode(b.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(b.slice(8, 12)) === "WEBP"
  ) {
    const type = new TextDecoder().decode(b.slice(12, 16));
    if (type === "VP8X") {
      width = 1 + b[24]! + (b[25]! << 8) + (b[26]! << 16);
      height = 1 + b[27]! + (b[28]! << 8) + (b[29]! << 16);
    } else if (type === "VP8 " && b[23] === 157 && b[24] === 1 && b[25] === 42) {
      width = view.getUint16(26, true) & 16383;
      height = view.getUint16(28, true) & 16383;
    } else if (type === "VP8L" && b[20] === 47) {
      width = 1 + b[21]! + ((b[22]! & 63) << 8);
      height = 1 + (b[22]! >> 6) + (b[23]! << 2) + ((b[24]! & 15) << 10);
    }
  }
  if (width < 1 || height < 1 || width * height > 16000000)
    throw new Error("Unsupported or oversized poster");
  return { width, height };
}
export function backgroundFromPixels(pixels: Uint8ClampedArray): string {
  let sin = 0,
    cos = 0,
    weight = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const r = pixels[i]! / 255,
      g = pixels[i + 1]! / 255,
      b = pixels[i + 2]! / 255,
      max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      d = max - min;
    if (d === 0) continue;
    const l = (max + min) / 2,
      s = d / (1 - Math.abs(2 * l - 1));
    if (s < 0.05) continue;
    const h =
      (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
    sin += Math.sin(h * 2 * Math.PI) * s;
    cos += Math.cos(h * 2 * Math.PI) * s;
    weight += s;
  }
  // Match get_dominant_hue / hue_to_background_rgb in cover_style.py.
  let hue = weight ? Math.atan2(sin / weight, cos / weight) / (2 * Math.PI) : 0;
  if (hue < 0) hue += 1;
  const lightness = 0.32,
    saturation = 0.32;
  const m2 = lightness * (1 + saturation),
    m1 = 2 * lightness - m2;
  const channel = (offset: number) => {
    const h = (((hue + offset) % 1) + 1) % 1;
    let value = m1;
    if (h < 1 / 6) value = m1 + (m2 - m1) * h * 6;
    else if (h < 1 / 2) value = m2;
    else if (h < 2 / 3) value = m1 + (m2 - m1) * (2 / 3 - h) * 6;
    return Math.floor(value * 255);
  };
  return `rgb(${channel(1 / 3)}, ${channel(0)}, ${channel(-1 / 3)})`;
}
const preprocess = async (url: string, signal?: AbortSignal) => {
  if (!url.startsWith("/api/dashboard/libraries/")) throw new Error("Invalid asset URL");
  const response = await fetch(url, {
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
    redirect: "error",
  });
  if (response.status === 401) throw new CoverSessionExpired();
  if (!response.ok) throw new Error("Poster unavailable");
  const blob = await response.blob();
  if (blob.size > 20 * 1024 * 1024) throw new Error("Poster too large");
  imageDimensions(new Uint8Array(await blob.arrayBuffer()));
  const loaded = await loadCoverImage(blob, signal),
    canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 576;
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    const { image } = loaded;
    const factor = Math.max(384 / image.naturalWidth, 576 / image.naturalHeight);
    const w = image.naturalWidth * factor,
      h = image.naturalHeight * factor;
    ctx.drawImage(image, (384 - w) / 2, (576 - h) / 2, w, h);
    const data = canvas.toDataURL("image/jpeg", 0.9);
    canvas.width = 100;
    canvas.height = 100;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, 100, 100);
    return { data, background: backgroundFromPixels(ctx.getImageData(0, 0, 100, 100).data) };
  } finally {
    loaded.release();
    canvas.width = 0;
    canvas.height = 0;
  }
};
export async function prepareLibraryCoverAssets(
  preparation: LibraryCoverPreparation,
  signal?: AbortSignal,
): Promise<{ posters: ReadonlyArray<string>; background: string }> {
  const results: Array<{ data: string; background: string }> = [];
  let index = 0;
  while (index < preparation.candidates.length && results.length < 9) {
    signal?.throwIfAborted();
    const batch = preparation.candidates.slice(index, index + Math.min(2, 9 - results.length));
    index += batch.length;
    const done = await Promise.allSettled(batch.map((c) => preprocess(c.url, signal)));
    for (const d of done)
      if (d.status === "rejected" && d.reason instanceof CoverSessionExpired) throw d.reason;
    for (const d of done) if (d.status === "fulfilled") results.push(d.value);
  }
  signal?.throwIfAborted();
  if (!results.length) throw new Error("No usable posters");
  return { posters: results.map((x) => x.data), background: results[0]!.background };
}
