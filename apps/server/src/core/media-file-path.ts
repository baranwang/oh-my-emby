import type { JsonValue } from "./model.js";

// Only expose a filename, never an upstream directory, URL, query or credential.
export const mediaFileName = (value: JsonValue | undefined): string | null => {
  // Control characters must never enter a public media path.
  // eslint-disable-next-line no-control-regex
  if (typeof value !== "string" || /[:?#\u0000-\u001f\u007f]/.test(value)) return null;
  const name = value.replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
  return name.length > 0 &&
    name.length <= 255 &&
    /\.(?:mkv|mp4|m4v|mov|avi|webm|ts|m2ts|mpg|mpeg|iso)$/i.test(name)
    ? name
    : null;
};

export const mediaFilePath = (
  canonicalId: string,
  versionId: string,
  name: JsonValue | undefined,
): string | null => {
  const filename = mediaFileName(name);
  // Infuse displays the last segment verbatim. Percent signs cannot safely serve
  // as both display text and URL escapes, so use the existing stream fallback.
  return filename === null || filename.includes("%")
    ? null
    : `/Videos/${encodeURIComponent(canonicalId)}/files/${encodeURIComponent(versionId)}/${filename}`;
};
