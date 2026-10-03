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
  const components = new Set<number>();
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
      const count = b[i + 7];
      if (
        dimensions ||
        b[i + 2] !== 8 ||
        count === undefined ||
        ![1, 3, 4].includes(count) ||
        size !== 8 + 3 * count
      )
        fail();
      for (let c = 0; c < count!; c++) {
        const id = b[i + 8 + 3 * c]!,
          sampling = b[i + 9 + 3 * c]!,
          table = b[i + 10 + 3 * c]!;
        if (
          components.has(id) ||
          sampling >> 4 < 1 ||
          sampling >> 4 > 4 ||
          (sampling & 15) < 1 ||
          (sampling & 15) > 4 ||
          table > 3
        )
          fail();
        components.add(id);
      }
      const h = (b[i + 3]! << 8) | b[i + 4]!,
        w = (b[i + 5]! << 8) | b[i + 6]!;
      if (w !== 1920 || h !== 1080) fail();
      dimensions = true;
    }
    if (m === 218) {
      const count = b[i + 2];
      if (
        !dimensions ||
        count === undefined ||
        count < 1 ||
        count > components.size ||
        size !== 6 + 2 * count ||
        i + size >= b.length - 2
      )
        fail();
      const scanComponents = new Set<number>();
      for (let c = 0; c < count!; c++) {
        const id = b[i + 3 + 2 * c]!,
          tables = b[i + 4 + 2 * c]!;
        if (!components.has(id) || scanComponents.has(id) || tables >> 4 > 3 || (tables & 15) > 3)
          fail();
        scanComponents.add(id);
      }
      const spectralStart = b[i + size - 3]!,
        spectralEnd = b[i + size - 2]!,
        approximation = b[i + size - 1]!;
      if (
        spectralStart > spectralEnd ||
        spectralEnd > 63 ||
        approximation >> 4 > 13 ||
        (approximation & 15) > 13
      )
        fail();
      return { width: 1920, height: 1080 };
    }
    i += size;
  }
  return fail();
}
