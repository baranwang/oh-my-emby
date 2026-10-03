import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { handleDashboardLibraryCover } from "../src/api/dashboard-library-covers.js";
const auth = { authenticateDashboard: () => Effect.succeed({}) } as any;
const cover = { body: new Uint8Array([1, 2, 3]), revision: "r1", width: 1920, height: 1080 };
const service = {
  read: () => Effect.succeed(cover),
  asset: () => Effect.succeed({ bytes: new Uint8Array([4, 5]), contentType: "image/jpeg" }),
  upload: () => Effect.succeed({ revision: "r2", width: 1920, height: 1080, stale: false }),
} as any;
const req = (path = "", method = "GET", headers: Record<string, string> = {}, body?: Uint8Array) =>
  new Request(`https://app.example/api/dashboard/libraries/lib/cover${path}`, {
    method,
    headers: { cookie: "oh_my_emby_session=session", ...headers },
    ...(body ? { body: body as any } : {}),
  });
const run = (request: Request) =>
  Effect.runPromise(handleDashboardLibraryCover(request, auth, service));
describe("dashboard cover boundary", () => {
  it("requires session before reading cover", async () => {
    const r = await run(new Request("https://app.example/api/dashboard/libraries/lib/cover"));
    expect(r?.status).toBe(401);
  });
  it("returns image bytes and HEAD metadata with ETag", async () => {
    const r = await run(req());
    expect(r?.status).toBe(200);
    expect(r?.headers.get("etag")).toBe('"r1"');
    expect(new Uint8Array(await r!.arrayBuffer())).toEqual(cover.body);
    const head = await run(req("", "HEAD"));
    expect(await head!.text()).toBe("");
    expect(head?.headers.get("content-length")).toBe("3");
    expect((await run(req("", "GET", { "if-none-match": '"r1"' })))?.status).toBe(304);
  });
  it("blocks foreign-origin upload", async () =>
    expect(
      (
        await run(
          req(
            "",
            "PUT",
            {
              origin: "https://evil.example",
              "content-type": "image/jpeg",
              "x-cover-token": "token",
            },
            new Uint8Array([1]),
          ),
        )
      )?.status,
    ).toBe(403));
  it("bounds streaming upload size", async () =>
    expect(
      (
        await run(
          req(
            "",
            "PUT",
            {
              origin: "https://app.example",
              "content-type": "image/jpeg",
              "x-cover-token": "token",
            },
            new Uint8Array(512001),
          ),
        )
      )?.status,
    ).toBe(413));
  it("proxies asset bytes without redirect", async () => {
    const r = await run(req("/assets/token/0"));
    expect(r?.status).toBe(200);
    expect(r?.headers.get("location")).toBe(null);
    expect(new Uint8Array(await r!.arrayBuffer())).toEqual(new Uint8Array([4, 5]));
  });
});
