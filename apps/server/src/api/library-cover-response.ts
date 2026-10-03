export const coverImageResponse = (
  request: Request,
  cover: { body: Uint8Array; revision: string },
) => {
  const etag = `"${cover.revision}"`;
  const headers = new Headers({
    "content-type": "image/jpeg",
    etag: etag,
    "cache-control": "private, no-cache",
    "x-content-type-options": "nosniff",
  });
  if (
    request.headers
      .get("if-none-match")
      ?.split(",")
      .map((x) => x.trim())
      .some((x) => x === etag || x === `W/${etag}` || x === "*")
  )
    return new Response(null, { status: 304, headers });
  headers.set("content-length", String(cover.body.byteLength));
  return new Response(request.method === "HEAD" ? null : Uint8Array.from(cover.body).buffer, {
    headers,
  });
};
