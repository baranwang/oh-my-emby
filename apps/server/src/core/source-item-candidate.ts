import type { JsonValue, EligibleSource } from "./model.js";
import type { ProviderIds, SourceItemCandidate } from "./identity.js";
export const isCatalogObject = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const providerIds = (item: Record<string, JsonValue>): ProviderIds => {
  const raw = item.ProviderIds;
  const ids: { readonly [key: string]: JsonValue } =
    raw !== undefined && isCatalogObject(raw) ? raw : {};
  const read = (name: string) => (typeof ids[name] === "string" ? ids[name] : null);
  return { tmdbMovie: read("Tmdb"), tmdbTv: read("Tmdb"), imdbTitle: read("Imdb") };
};

export const mediaVersions = (item: Record<string, JsonValue>, provider: string) =>
  Array.isArray(item.MediaSources)
    ? item.MediaSources.flatMap((entry) => {
        if (!isCatalogObject(entry) || typeof entry.Id !== "string") return [];
        const name = typeof entry.Name === "string" ? entry.Name : entry.Id;
        return [
          {
            upstreamMediaSourceId: entry.Id,
            label: `[${provider}] ${name}`,
            capabilities: entry,
            streams: Array.isArray(entry.MediaStreams) ? entry.MediaStreams : [],
          },
        ];
      })
    : [];

export const sourceItemCandidate = (
  source: EligibleSource,
  item: Record<string, JsonValue>,
  observedAtMs: number,
): SourceItemCandidate => ({
  serverId: source.serverId,
  catalogNamespace: source.catalogNamespace,
  verifiedCatalogId: source.verifiedCatalogId,
  serverGeneration: source.serverGeneration,
  sourceLibraryId: source.sourceLibraryId,
  upstreamItemId: item.Id as string,
  itemType: item.Type as SourceItemCandidate["itemType"],
  providerIds: providerIds(item),
  displayMetadata: item,
  mediaVersions: mediaVersions(item, source.name),
  observedAtMs,
});
