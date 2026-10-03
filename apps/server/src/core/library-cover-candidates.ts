import { Effect, Result, Schema } from "effect";
import type { CatalogItemRecord, RepositoriesService } from "./repositories.js";
import type { UpstreamClientService } from "./upstream-client.js";
import type { IdentityApi } from "./identity.js";
import type { VirtualLibrary, EligibleSource } from "./model.js";
import type { CoverCandidate } from "./library-cover-model.js";
import { isCatalogObject, sourceItemCandidate } from "./source-item-candidate.js";
const Page = Schema.Struct({ Items: Schema.Array(Schema.Unknown) });
export const makeLibraryCoverCandidateSelector =
  (repo: RepositoriesService, upstream: UpstreamClientService, identity: IdentityApi) =>
  (library: VirtualLibrary) =>
    Effect.gen(function* () {
      const sources = yield* repo.resolveEligibleSources(library.id);
      const expected = library.mediaType === "series" ? "Series" : "Movie";
      const chosen = new Map<string, CoverCandidate>();
      const add = (
        canonicalId: string,
        source: EligibleSource,
        upstreamItemId: string,
        metadata: unknown,
      ) => {
        if (chosen.size >= 18 || chosen.has(canonicalId) || !isCatalogObject(metadata)) return;
        const tags = metadata.ImageTags;
        const tag = isCatalogObject(tags) && typeof tags.Primary === "string" ? tags.Primary : null;
        if (!tag) return;
        chosen.set(canonicalId, {
          canonicalId,
          serverId: source.serverId,
          sourceLibraryId: source.sourceLibraryId,
          serverGeneration: source.serverGeneration,
          upstreamItemId,
          imageTag: tag,
        });
      };
      const ids = yield* repo.listLibraryCoverCandidateIds(library.id, 200);
      // The D1 catalog query reserves two parameters for freshness timestamps.
      const records: CatalogItemRecord[] = [];
      for (let offset = 0; offset < ids.length; offset += 98)
        records.push(...(yield* repo.readCatalogItems(ids.slice(offset, offset + 98), Date.now())));
      for (const r of [...records].sort((a, b) => a.canonical.id.localeCompare(b.canonical.id))) {
        if (r.canonical.itemType !== expected) continue;
        for (const item of r.sourceItems) {
          const source = sources.find(
            (s) =>
              s.serverId === item.serverId &&
              s.sourceLibraryId === item.sourceLibraryId &&
              s.serverGeneration === item.serverGeneration,
          );
          if (source && item.quarantineReason === null && item.itemType === expected)
            add(r.canonical.id, source, item.upstreamItemId, r.canonical.displayMetadata);
        }
      }
      if (chosen.size >= 9) return [...chosen.values()];
      for (const source of sources.slice(0, 10)) {
        if (chosen.size >= 18) break;
        const server = yield* repo.getServer(source.serverId);
        if (!server?.upstreamUserId) continue;
        const path = (userId: string) =>
          "/Items?" +
          new URLSearchParams({
            UserId: userId,
            ParentId: source.sourceLibraryId,
            Recursive: "true",
            IncludeItemTypes: expected,
            StartIndex: "0",
            Limit: "20",
            Fields: "ProviderIds,ImageTags",
            SortBy: "SortName",
            SortOrder: "Ascending",
          });
        const response = yield* upstream
          .request(
            {
              serverId: source.serverId,
              generation: source.serverGeneration,
              path: path(server.upstreamUserId),
              replayPath: path,
              method: "GET",
            },
            Page,
          )
          .pipe(Effect.result);
        if (Result.isFailure(response)) continue;
        for (const raw of response.success.Items.slice(0, 20)) {
          if (chosen.size >= 18) break;
          if (
            !isCatalogObject(raw) ||
            typeof raw.Id !== "string" ||
            raw.Type !== expected ||
            !isCatalogObject(raw.ImageTags) ||
            typeof raw.ImageTags.Primary !== "string"
          )
            continue;
          const resolved = yield* identity
            .resolve(sourceItemCandidate(source, raw, Date.now()))
            .pipe(Effect.result);
          if (Result.isFailure(resolved) || resolved.success.sourceItem.quarantineReason !== null)
            continue;
          yield* repo.persistIdentityResult(resolved.success);
          add(resolved.success.canonical.id, source, raw.Id, raw);
        }
      }
      return [...chosen.values()];
    });
