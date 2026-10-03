import type { LibraryCoverPreparation, LibraryCoverSummary } from "@oh-my-emby/contracts";
import { Context, Effect, Layer } from "effect";
import { Repositories, type RepositoriesService } from "./repositories.js";
import { UpstreamClient, type UpstreamClientService } from "./upstream-client.js";
import { Identity, type IdentityApi } from "./identity.js";
import { LibraryNotFound } from "./errors.js";
import {
  COVER_TEMPLATE_VERSION,
  LibraryCoverConflict,
  LibraryCoverValidationFailed,
  libraryCoverConfigDigest,
} from "./library-cover-model.js";
import { validateLibraryCoverJpeg } from "./library-cover-jpeg.js";
import { makeLibraryCoverCandidateSelector } from "./library-cover-candidates.js";
export const makeLibraryCoverService = (
  repo: RepositoriesService,
  upstream: UpstreamClientService,
  identity: IdentityApi,
  now = Date.now,
) => {
  const get = (id: string) =>
    repo.listVirtualLibraries().pipe(
      Effect.flatMap((ls) => {
        const l = ls.find((x) => x.id === id && x.enabled);
        return l ? Effect.succeed(l) : Effect.fail(new LibraryNotFound({ libraryId: id }));
      }),
    );
  const manifest = (libraryId: string, token: string) =>
    Effect.gen(function* () {
      const l = yield* get(libraryId),
        m = yield* repo.getLibraryCoverManifest(token);
      if (
        !m ||
        m.libraryId !== libraryId ||
        m.expiresAtMs <= now() ||
        m.configDigest !== libraryCoverConfigDigest(l)
      )
        return yield* Effect.fail(new LibraryCoverConflict());
      const sources = yield* repo.resolveEligibleSources(libraryId);
      if (
        m.serverFences.some(
          (f) =>
            !sources.some((s) => s.serverId === f.serverId && s.serverGeneration === f.generation),
        )
      )
        return yield* Effect.fail(new LibraryCoverConflict());
      return m;
    });
  return {
    prepare: (id: string) =>
      Effect.gen(function* () {
        const l = yield* get(id);
        const candidates = yield* makeLibraryCoverCandidateSelector(repo, upstream, identity)(l);
        if (!candidates.length)
          return yield* Effect.fail(
            new LibraryCoverValidationFailed({ message: "No usable posters in this library" }),
          );
        const old = yield* repo.getLibraryCover(id);
        const token = crypto.randomUUID(),
          expiresAtMs = now() + 600000;
        const serverFences = [
          ...new Map(
            candidates.map((c) => [
              c.serverId,
              { serverId: c.serverId as never, generation: c.serverGeneration },
            ]),
          ).values(),
        ];
        yield* repo.saveLibraryCoverManifest({
          token,
          libraryId: id,
          configDigest: libraryCoverConfigDigest(l),
          serverFences,
          candidates,
          expectedRevision: old?.revision ?? null,
          expiresAtMs,
        });
        const p: LibraryCoverPreparation = {
          token,
          title: l.name,
          subtitle: l.mediaType === "movies" ? "Movies" : "TV Series",
          templateVersion: COVER_TEMPLATE_VERSION,
          expiresAtMs,
          candidates: candidates.map((_, index) => ({
            index,
            url: `/api/dashboard/libraries/${encodeURIComponent(id)}/cover/assets/${token}/${index}`,
          })),
        };
        return p;
      }),
    read: (id: string) => get(id).pipe(Effect.flatMap(() => repo.getLibraryCover(id))),
    upload: (input: { libraryId: string; token: string; bytes: Uint8Array }) =>
      Effect.gen(function* () {
        const m = yield* manifest(input.libraryId, input.token);
        const dimensions = yield* Effect.try({
          try: () => validateLibraryCoverJpeg(input.bytes),
          catch: (e) => e as LibraryCoverValidationFailed,
        });
        const revision = yield* Effect.promise(async () => {
          const d = await crypto.subtle.digest("SHA-256", Uint8Array.from(input.bytes));
          return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
        });
        const committed = yield* repo.commitLibraryCover({
          token: input.token,
          nowMs: now(),
          cover: {
            libraryId: input.libraryId,
            body: input.bytes,
            revision,
            configDigest: m.configDigest,
            templateVersion: COVER_TEMPLATE_VERSION,
            ...dimensions,
            updatedAtMs: now(),
          },
        });
        if (!committed) return yield* Effect.fail(new LibraryCoverConflict());
        const summary: LibraryCoverSummary = { revision, ...dimensions, stale: false };
        return summary;
      }),
    asset: (input: { libraryId: string; token: string; index: number; signal?: AbortSignal }) =>
      Effect.gen(function* () {
        const m = yield* manifest(input.libraryId, input.token),
          c = m.candidates[input.index];
        if (!Number.isSafeInteger(input.index) || input.index < 0 || !c)
          return yield* Effect.fail(
            new LibraryCoverValidationFailed({ message: "Invalid cover asset" }),
          );
        const sources = yield* repo.resolveEligibleSources(input.libraryId);
        if (
          !sources.some(
            (s) =>
              s.serverId === c.serverId &&
              s.sourceLibraryId === c.sourceLibraryId &&
              s.serverGeneration === c.serverGeneration,
          )
        )
          return yield* Effect.fail(new LibraryCoverConflict());
        const p = new URLSearchParams({
          MaxWidth: "384",
          MaxHeight: "576",
          Quality: "85",
          ...(c.imageTag ? { tag: c.imageTag } : {}),
        });
        const image = yield* upstream.requestImage({
          serverId: c.serverId,
          generation: c.serverGeneration,
          method: "GET",
          path: `/Items/${encodeURIComponent(c.upstreamItemId)}/Images/Primary?${p}`,
        });
        yield* manifest(input.libraryId, input.token);
        return image;
      }),
  };
};
export type LibraryCoverServiceApi = ReturnType<typeof makeLibraryCoverService>;
export class LibraryCoverService extends Context.Service<
  LibraryCoverService,
  LibraryCoverServiceApi
>()("oh-my-emby/LibraryCoverService") {}
export const makeLibraryCoverServiceLayer = Layer.effect(
  LibraryCoverService,
  Effect.gen(function* () {
    return makeLibraryCoverService(yield* Repositories, yield* UpstreamClient, yield* Identity);
  }),
);
