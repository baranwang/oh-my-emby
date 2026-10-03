import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeLibraryCoverRepositories } from "../src/core/library-cover-repositories.js";
export function libraryCoverRepositoryContract(
  sql: Parameters<typeof makeLibraryCoverRepositories>[0],
  seed: () => Promise<void>,
) {
  describe("library cover storage", () => {
    it("persists bytes and consumes concurrent old-version manifests atomically", async () => {
      await seed();
      const repo = makeLibraryCoverRepositories(sql);
      const configDigest = JSON.stringify({
        name: "Movies",
        mediaType: "movies",
        enabled: true,
        sources: [],
      });
      const manifest = {
        token: "token-1",
        libraryId: "cover-library",
        configDigest,
        serverFences: [],
        candidates: [],
        expectedRevision: null,
        expiresAtMs: Date.now() + 600000,
      };
      await Effect.runPromise(repo.saveLibraryCoverManifest(manifest));
      await Effect.runPromise(repo.saveLibraryCoverManifest({ ...manifest, token: "token-2" }));
      const cover = {
        libraryId: manifest.libraryId,
        body: new Uint8Array([1, 2, 3]),
        revision: "revision-1",
        templateVersion: "v1",
        configDigest,
        width: 1920 as const,
        height: 1080 as const,
        updatedAtMs: 1000,
      };
      expect(
        await Effect.runPromise(repo.commitLibraryCover({ token: "token-1", cover, nowMs: 1000 })),
      ).toBe(true);
      expect(
        await Effect.runPromise(
          repo.commitLibraryCover({
            token: "token-2",
            cover: { ...cover, revision: "revision-2" },
            nowMs: 1000,
          }),
        ),
      ).toBe(false);
      expect((await Effect.runPromise(repo.getLibraryCover(manifest.libraryId)))?.body).toEqual(
        cover.body,
      );
      expect(await Effect.runPromise(repo.getLibraryCoverManifest("token-1"))).toBe(null);
    });
    it("expires manifests and caps them at four", async () => {
      await seed();
      const repo = makeLibraryCoverRepositories(sql);
      const manifest = {
        token: "expire",
        libraryId: "cover-library",
        configDigest: JSON.stringify({
          name: "Movies",
          mediaType: "movies",
          enabled: true,
          sources: [],
        }),
        serverFences: [],
        candidates: [],
        expectedRevision: null,
        expiresAtMs: 10,
      };
      for (let i = 0; i < 5; i++)
        await Effect.runPromise(
          repo.saveLibraryCoverManifest({
            ...manifest,
            token: `cap-${i}`,
            expiresAtMs: Date.now() + 10000 + i,
          }),
        );
      expect(await Effect.runPromise(repo.getLibraryCoverManifest("cap-0"))).toBe(null);
      await Effect.runPromise(repo.saveLibraryCoverManifest(manifest));
      const cover = {
        libraryId: manifest.libraryId,
        body: new Uint8Array([1]),
        revision: "r",
        templateVersion: "v1",
        configDigest: manifest.configDigest,
        width: 1920 as const,
        height: 1080 as const,
        updatedAtMs: 10,
      };
      expect(
        await Effect.runPromise(repo.commitLibraryCover({ token: "expire", cover, nowMs: 10 })),
      ).toBe(false);
    });

    it("rejects obsolete configuration and cascades deletion of covers and manifests", async () => {
      await seed();
      const repo = makeLibraryCoverRepositories(sql);
      const configDigest = JSON.stringify({
        name: "Movies",
        mediaType: "movies",
        enabled: true,
        sources: [],
      });
      const m = {
        token: "config-token",
        libraryId: "cover-library",
        configDigest,
        serverFences: [],
        candidates: [],
        expectedRevision: null,
        expiresAtMs: Date.now() + 600000,
      };
      const cover = {
        libraryId: m.libraryId,
        body: new Uint8Array([1]),
        revision: "r",
        templateVersion: "v1",
        configDigest,
        width: 1920 as const,
        height: 1080 as const,
        updatedAtMs: 1000,
      };
      await Effect.runPromise(repo.saveLibraryCoverManifest(m));
      await Effect.runPromise(
        sql.unsafe("UPDATE virtual_libraries SET name='Renamed' WHERE id=?", [m.libraryId]),
      );
      expect(
        await Effect.runPromise(
          repo.commitLibraryCover({ token: m.token, cover, nowMs: Date.now() }),
        ),
      ).toBe(false);
      expect(await Effect.runPromise(repo.getLibraryCover(m.libraryId))).toBeNull();
      await Effect.runPromise(
        sql.unsafe("UPDATE virtual_libraries SET name='Movies' WHERE id=?", [m.libraryId]),
      );
      expect(
        await Effect.runPromise(
          repo.commitLibraryCover({ token: m.token, cover, nowMs: Date.now() }),
        ),
      ).toBe(true);
      await Effect.runPromise(
        repo.saveLibraryCoverManifest({ ...m, token: "delete-token", expectedRevision: "r" }),
      );
      await Effect.runPromise(
        sql.unsafe("DELETE FROM virtual_libraries WHERE id=?", [m.libraryId]),
      );
      expect(await Effect.runPromise(repo.getLibraryCover(m.libraryId))).toBeNull();
      expect(await Effect.runPromise(repo.getLibraryCoverManifest("delete-token"))).toBeNull();
    });
  });
}
