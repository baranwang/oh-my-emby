import { describe, expect, it, vi } from "vitest";
import { generateLibraryCover } from "../src/modules/libraries/services/library-cover-service";
const { handleUnauthorized, runProtected } = vi.hoisted(() => ({
  handleUnauthorized: vi.fn(async () => {}),
  runProtected: vi.fn(async () => ({ candidates: [] })),
}));
vi.mock("../src/modules/auth/services/auth-service", () => ({ handleUnauthorized, runProtected }));
vi.mock("../src/modules/libraries/covers/assets", () => {
  class CoverSessionExpired extends Error {
    constructor() {
      super("Session expired");
      this.name = "CoverSessionExpired";
    }
  }
  return {
    CoverSessionExpired,
    prepareLibraryCoverAssets: async () => {
      throw new CoverSessionExpired();
    },
  };
});
vi.mock("../src/modules/libraries/covers/render", () => ({ renderLibraryCover: vi.fn() }));
describe("cover session handling", () => {
  it("clears protected queries when the session expires during assets", async () => {
    const queryClient = {} as any;
    await expect(generateLibraryCover("lib", queryClient)).rejects.toThrow("Session expired");
    expect(handleUnauthorized).toHaveBeenCalledExactlyOnceWith(queryClient);
  });
});
