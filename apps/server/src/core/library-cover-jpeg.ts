import { LibraryCoverValidationFailed, MAX_COVER_BYTES } from "./library-cover-model.js";
export function validateLibraryCoverJpeg(b: Uint8Array): { width: 1920; height: 1080 } {
  const fail = () => {
    throw new LibraryCoverValidationFailed({
      message: "Expected a valid 1920×1080 JPEG within 500 KiB",
    });
  };
  if (
    b.length > MAX_COVER_BYTES ||
    b.length < 4 ||
    b[0] !== 255 ||
    b[1] !== 216 ||
    b.at(-2) !== 255 ||
    b.at(-1) !== 217
  )
    fail();
  let dimensions = false;
  for (let i = 2; i < b.length;) {
    if (b[i++] !== 255) fail();
    while (b[i] === 255) i++;
    const m = b[i++];
    if (m === undefined) fail();
    if (m === 217) break;
    if (m === 1 || (m! >= 208 && m! <= 215)) continue;
    if (i + 2 > b.length) fail();
    const size = (b[i]! << 8) | b[i + 1]!;
    if (size < 2 || i + size > b.length) fail();
    if (m === 192 || m === 194) {
      if (size < 11) fail();
      const h = (b[i + 3]! << 8) | b[i + 4]!,
        w = (b[i + 5]! << 8) | b[i + 6]!;
      if (w !== 1920 || h !== 1080) fail();
      dimensions = true;
    }
    if (m === 218) {
      if (!dimensions) fail();
      return { width: 1920, height: 1080 };
    }
    i += size;
  }
  return fail();
}
