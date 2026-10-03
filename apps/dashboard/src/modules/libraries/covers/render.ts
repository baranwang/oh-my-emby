import yogaUrl from "satori/yoga.wasm?url";
import { createLibraryCoverTemplate, type CoverRenderInput } from "./template.js";
export const SYSTEM_FONT_STACK = 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
export function fitCoverTitle(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): { text: string; size: number } {
  let size = 192;
  for (; size > 108; size -= 6) {
    ctx.font = `700 ${size}px ${SYSTEM_FONT_STACK}`;
    if (ctx.measureText(text).width <= maxWidth) return { text, size };
  }
  ctx.font = `700 ${size}px ${SYSTEM_FONT_STACK}`;
  if (ctx.measureText(text).width <= maxWidth) return { text, size };
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
  ].map((x) => x.segment);
  while (graphemes.length && ctx.measureText(graphemes.join("") + "…").width > maxWidth)
    graphemes.pop();
  return { text: graphemes.join("") + "…", size };
}
export const encodeCoverJpeg = async (
  canvas: HTMLCanvasElement,
  signal?: AbortSignal,
): Promise<Blob> => {
  for (const quality of [0.85, 0.75, 0.65, 0.55, 0.5]) {
    signal?.throwIfAborted();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (!blob) throw new Error("Image encoding failed");
    if (blob.size <= 512000) return blob;
  }
  throw new Error("Cover exceeds 500 KiB");
};
export const loadCoverImage = (
  blob: Blob,
  signal?: AbortSignal,
): Promise<{ image: HTMLImageElement; release: () => void }> =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const url = URL.createObjectURL(blob),
      image = new Image();
    let settled = false;
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      image.src = "";
      URL.revokeObjectURL(url);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    image.onload = () => {
      settled = true;
      cleanup();
      resolve({ image, release: () => URL.revokeObjectURL(url) });
    };
    image.onerror = () => {
      settled = true;
      cleanup();
      URL.revokeObjectURL(url);
      reject(new Error("Image decode failed"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    image.src = url;
  });
export async function renderLibraryCover(
  input: CoverRenderInput,
  signal?: AbortSignal,
): Promise<Blob> {
  signal?.throwIfAborted();
  const satori = await loadSatori();
  const svg = await satori(createLibraryCoverTemplate(input), {
    width: 1920,
    height: 1080,
    fonts: [],
  });
  signal?.throwIfAborted();
  const loaded = await loadCoverImage(new Blob([svg], { type: "image/svg+xml" }), signal);
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.drawImage(loaded.image, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "top";
    const title = fitCoverTitle(ctx, input.title, 780);
    ctx.fillText(title.text, 144, 336);
    ctx.font = `600 72px ${SYSTEM_FONT_STACK}`;
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillText(input.subtitle, 144, 612);
    return await encodeCoverJpeg(canvas, signal);
  } finally {
    loaded.release();
    canvas.width = 0;
    canvas.height = 0;
  }
}

let satoriPromise: Promise<typeof import("satori/standalone").default> | undefined;
const loadSatori = () =>
  (satoriPromise ??= (async () => {
    const module = await import("satori/standalone");
    const response = await fetch(yogaUrl);
    if (!response.ok) throw new Error("Layout engine unavailable");
    await module.init(await response.arrayBuffer());
    return module.default;
  })().catch((error) => {
    satoriPromise = undefined;
    throw error;
  }));
