import { afterEach, expect, it, vi } from "vitest";
import { generateLibraryCover } from "../src/modules/libraries/services/library-cover-service";
vi.mock("../src/modules/auth/services/auth-service", () => ({
  handleUnauthorized: vi.fn(),
  runProtected: async () => ({
    title: "Movies",
    subtitle: "Movies",
    token: "token",
    candidates: [],
  }),
}));
vi.mock("../src/modules/libraries/covers/assets", () => ({
  CoverSessionExpired: class extends Error {},
  prepareLibraryCoverAssets: async () => ({ posters: ["poster"], background: "#000" }),
}));
vi.mock("../src/modules/libraries/covers/render", () => ({
  renderLibraryCover: async () => new Blob(["image"], { type: "image/jpeg" }),
}));
afterEach(() => vi.unstubAllGlobals());
it("reads the saved cover after another tab wins the upload", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 409 })),
  );
  const cover = { revision: "winner", width: 1920, height: 1080, stale: false };
  const queryClient = {
    invalidateQueries: vi.fn(async () => {}),
    fetchQuery: vi.fn(async () => ({ cover })),
  } as any;
  expect(await generateLibraryCover("lib", queryClient)).toEqual(cover);
  expect(queryClient.invalidateQueries).toHaveBeenCalledOnce();
  expect(queryClient.fetchQuery).toHaveBeenCalledOnce();
});
