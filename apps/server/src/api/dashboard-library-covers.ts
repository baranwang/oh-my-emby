import { Effect, Result } from "effect";
import type { AuthService } from "../core/auth.js";
import type { LibraryCoverServiceApi } from "../core/library-covers.js";
import { MAX_COVER_BYTES } from "../core/library-cover-model.js";
import {
  authorizeDashboardControlRequest,
  publicFailure,
  DASHBOARD_SESSION_COOKIE,
} from "./dashboard.js";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
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
const readUpload = async (request: Request) => {
  if (!request.body) throw new Error("empty");
  const size = request.headers.get("content-length");
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_COVER_BYTES)) {
    await request.body.cancel();
    throw new Error("oversize");
  }
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel();
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (request.signal.aborted) throw new Error("aborted");
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_COVER_BYTES) throw new Error("oversize");
      chunks.push(part.value);
    }
  } finally {
    request.signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return bytes;
};
export const handleDashboardLibraryCover = (
  request: Request,
  auth: Pick<AuthService, "authenticateDashboard">,
  covers: LibraryCoverServiceApi,
  remoteAddress?: string,
) =>
  Effect.gen(function* () {
    const path = new URL(request.url).pathname;
    const match = /^\/api\/dashboard\/libraries\/([^/]+)\/cover(?:\/assets\/([^/]+)\/(\d+))?$/.exec(
      path,
    );
    if (!match) return null;
    let libraryId: string, token: string | undefined;
    try {
      libraryId = decodeURIComponent(match[1]!);
      token = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
    } catch {
      return Response.json({ _tag: "NotFound" }, { status: 404 });
    }
    const cookie = request.headers
      .get("cookie")
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${DASHBOARD_SESSION_COOKIE}=`))
      ?.slice(DASHBOARD_SESSION_COOKIE.length + 1);
    const access = yield* authorizeDashboardControlRequest(
      {
        method: request.method,
        requestUrl: request.url,
        headers: Object.fromEntries(request.headers),
        ...(remoteAddress === undefined ? {} : { remoteAddress }),
      },
      cookie,
      auth.authenticateDashboard,
    ).pipe(Effect.result);
    if (Result.isFailure(access)) return HttpServerResponse.toWeb(publicFailure(access.failure));
    if (token !== undefined) {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      const result = yield* covers
        .asset({ libraryId, token, index: Number(match[3]), signal: request.signal })
        .pipe(Effect.result);
      if (Result.isFailure(result)) return failure(result.failure);
      return new Response(Uint8Array.from(result.success.bytes).buffer, {
        headers: {
          "content-type": result.success.contentType,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (request.method === "GET" || request.method === "HEAD") {
      const result = yield* covers.read(libraryId).pipe(Effect.result);
      if (Result.isFailure(result)) return failure(result.failure);
      return result.success
        ? coverImageResponse(request, result.success)
        : Response.json({ _tag: "NotFound" }, { status: 404 });
    }
    if (request.method === "PUT") {
      const token = request.headers.get("x-cover-token");
      if (!token || request.headers.get("content-type")?.split(";")[0] !== "image/jpeg")
        return Response.json(
          {
            _tag: "ValidationFailed",
            fieldErrors: [{ field: "cover", message: "JPEG and generation token required" }],
          },
          { status: 400 },
        );
      const bytes = yield* Effect.tryPromise({
        try: () => readUpload(request),
        catch: (e) => e,
      }).pipe(Effect.result);
      if (Result.isFailure(bytes))
        return Response.json(
          {
            _tag: "ValidationFailed",
            fieldErrors: [{ field: "cover", message: "Invalid or oversized upload" }],
          },
          {
            status:
              bytes.failure instanceof Error && bytes.failure.message === "oversize" ? 413 : 400,
          },
        );
      const result = yield* covers
        .upload({ libraryId, token, bytes: bytes.success })
        .pipe(Effect.result);
      return Result.isFailure(result) ? failure(result.failure) : Response.json(result.success);
    }
    return new Response(null, { status: 405 });
  });
const failure = (error: { readonly _tag?: string }) =>
  error._tag === "LibraryCoverConflict"
    ? Response.json({ _tag: "Conflict", code: "cover_generation_obsolete" }, { status: 409 })
    : error._tag === "LibraryCoverValidationFailed"
      ? Response.json(
          {
            _tag: "ValidationFailed",
            fieldErrors: [{ field: "cover", message: "Cover generation input is invalid" }],
          },
          { status: 400 },
        )
      : HttpServerResponse.toWeb(publicFailure(error));
