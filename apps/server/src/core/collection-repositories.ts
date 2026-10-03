import { Effect } from "effect";
import { RepositoryError } from "./errors.js";
import type { JsonValue } from "./model.js";
import type {
  CollectionRepositories,
  CollectionRecord,
  CollectionScope,
  CollectionSource,
} from "./collection-model.js";

interface Command {
  readonly statement: string;
  readonly params: ReadonlyArray<unknown>;
}
export interface CollectionSql {
  readonly unsafe: <A extends object>(
    statement: string,
    params?: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<A>, unknown>;
  readonly batch: (commands: ReadonlyArray<Command>) => Effect.Effect<unknown, unknown>;
}
const sourceKey = (s: CollectionSource) =>
  JSON.stringify([s.serverId, s.catalogNamespace, s.serverGeneration, s.upstreamBoxSetId]);
const sourceCollectionId = (s: CollectionSource) =>
  `collection:source:${encodeURIComponent(sourceKey(s))}`;
const tmdbId = (id: string) => `collection:tmdb:${id}`;
const fence = `EXISTS(SELECT 1 FROM upstream_servers WHERE id=? AND catalog_namespace=? AND generation=? AND enabled=1 AND deleted_at_ms IS NULL AND health='healthy')`;
const fenceParams = (s: CollectionSource) => [s.serverId, s.catalogNamespace, s.serverGeneration];
interface Row {
  id: string;
  tmdb_collection_id: string | null;
  metadata_json: string;
  created_at_ms: number;
  updated_at_ms: number;
}
const record = (r: Row): CollectionRecord => ({
  id: r.id,
  tmdbCollectionId: r.tmdb_collection_id,
  displayMetadata: JSON.parse(r.metadata_json) as JsonValue,
  createdAtMs: r.created_at_ms,
  updatedAtMs: r.updated_at_ms,
});
const eligible = `si.item_type='Movie' AND si.quarantine_reason IS NULL AND si.canonical_id IS NOT NULL
 AND us.enabled=1 AND us.deleted_at_ms IS NULL AND us.health='healthy'
 AND si.server_generation=us.generation AND si.catalog_namespace=us.catalog_namespace
 AND cm.server_generation=si.server_generation
 AND EXISTS(SELECT 1 FROM library_sources ls JOIN virtual_libraries vl ON vl.id=ls.virtual_library_id
 WHERE ls.server_id=si.server_id AND ls.source_library_id=si.source_library_id AND ls.enabled=1 AND vl.enabled=1 AND vl.media_type='movies' AND (? IS NULL OR vl.id=?))
 AND (cm.evidence_type='tmdb' OR EXISTS(SELECT 1 FROM collection_sources cs
 WHERE cs.id=cm.collection_source_id AND cs.server_id=us.id AND cs.server_generation=us.generation AND cs.catalog_namespace=us.catalog_namespace))`;
const scopeParams = (scope: CollectionScope) => [scope.virtualLibraryId, scope.virtualLibraryId];
const revision: Command = {
  statement: "UPDATE collection_revision SET revision=revision+1 WHERE singleton=1",
  params: [],
};

export const makeCollectionRepositories = (sql: CollectionSql): CollectionRepositories => {
  const run = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new RepositoryError({
            operation,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );
  const resolve = (id: string) =>
    Effect.gen(function* () {
      const rows = yield* sql.unsafe<{ id: string }>(
        `WITH RECURSIVE ids(id,depth) AS (SELECT ?,0 UNION ALL SELECT ca.collection_id,depth+1 FROM collection_aliases ca JOIN ids ON ca.alias_id=ids.id WHERE depth<32) SELECT id FROM ids ORDER BY depth DESC LIMIT 1`,
        [id],
      );
      return rows[0]?.id ?? id;
    });
  const readCollectionMovies: CollectionRepositories["readCollectionMovies"] = (id, scope) =>
    run(
      "readCollectionMovies",
      Effect.gen(function* () {
        const active = yield* resolve(id);
        const rows = yield* sql.unsafe<{ canonicalId: string; sourceItemId: string }>(
          `SELECT si.canonical_id AS canonicalId, MIN(si.id) AS sourceItemId FROM collection_members cm JOIN source_items si ON si.id=cm.source_item_id JOIN upstream_servers us ON us.id=si.server_id WHERE cm.collection_id=? AND ${eligible} GROUP BY si.canonical_id ORDER BY si.canonical_id`,
          [active, ...scopeParams(scope)],
        );
        return rows;
      }),
    );
  const upsertCollection: CollectionRepositories["upsertCollection"] = (input) =>
    run(
      "upsertCollection",
      Effect.gen(function* () {
        if (!input.source && !input.tmdbCollectionId) return null;
        if (input.tmdbCollectionId && !/^[1-9]\d*$/.test(input.tmdbCollectionId)) return null;
        const source = input.source;
        let old:
          | { collection_id: string; tmdb_collection_id: string | null; updated_at_ms: number }
          | undefined;
        if (source) {
          if (
            !(yield* sql.unsafe(
              fence.replace("EXISTS(", "SELECT 1 WHERE EXISTS("),
              fenceParams(source),
            )).length
          )
            return null;
          old = (yield* sql.unsafe<{
            collection_id: string;
            tmdb_collection_id: string | null;
            updated_at_ms: number;
          }>(
            `SELECT cs.collection_id,mc.tmdb_collection_id,cs.updated_at_ms FROM collection_sources cs JOIN movie_collections mc ON mc.id=cs.collection_id WHERE cs.id=?`,
            [sourceKey(source)],
          ))[0];
          if (old && old.updated_at_ms > input.observedAtMs) return null;
        }
        // A previously proven source identity is not silently reassigned to a conflicting TMDB set.
        const conflict =
          old?.tmdb_collection_id &&
          input.tmdbCollectionId &&
          old.tmdb_collection_id !== input.tmdbCollectionId;
        const id = conflict
          ? old!.collection_id
          : (input.tmdbCollectionId
            ? tmdbId(input.tmdbCollectionId)
            : (old?.collection_id ?? sourceCollectionId(source!)));
        const guard = source ? fence : "1=1",
          gp = source ? fenceParams(source) : [];
        const commands: Command[] = [
          {
            statement: `INSERT INTO movie_collections(id,tmdb_collection_id,metadata_json,created_at_ms,updated_at_ms) SELECT ?,?,?,?,? WHERE ${guard} ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json,updated_at_ms=excluded.updated_at_ms WHERE movie_collections.updated_at_ms<=excluded.updated_at_ms`,
            params: [
              id,
              conflict ? old!.tmdb_collection_id : input.tmdbCollectionId,
              JSON.stringify(input.metadata),
              input.observedAtMs,
              input.observedAtMs,
              ...gp,
            ],
          },
        ];
        if (source) {
          commands.push({
            statement: `INSERT INTO collection_sources(id,collection_id,server_id,catalog_namespace,server_generation,upstream_boxset_id,metadata_json,updated_at_ms) SELECT ?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(id) DO UPDATE SET collection_id=excluded.collection_id,metadata_json=excluded.metadata_json,updated_at_ms=excluded.updated_at_ms WHERE collection_sources.updated_at_ms<=excluded.updated_at_ms`,
            params: [
              sourceKey(source),
              id,
              source.serverId,
              source.catalogNamespace,
              source.serverGeneration,
              source.upstreamBoxSetId,
              JSON.stringify(input.metadata),
              input.observedAtMs,
              ...gp,
            ],
          });
          if (old && old.collection_id !== id) {
            commands.push({
              statement: `UPDATE collection_members SET collection_id=? WHERE collection_id=? AND ${guard}`,
              params: [id, old.collection_id, ...gp],
            });
            commands.push({
              statement: `UPDATE collection_sources SET collection_id=? WHERE collection_id=? AND ${guard}`,
              params: [id, old.collection_id, ...gp],
            });
            commands.push({
              statement: `UPDATE collection_aliases SET collection_id=? WHERE collection_id=? AND ${guard}`,
              params: [id, old.collection_id, ...gp],
            });
            commands.push({
              statement: `INSERT INTO collection_aliases(alias_id,collection_id) SELECT ?,? WHERE ${guard} ON CONFLICT(alias_id) DO UPDATE SET collection_id=excluded.collection_id`,
              params: [old.collection_id, id, ...gp],
            });
          }
        }
        commands.push(revision);
        yield* sql.batch(commands);
        const rows = yield* sql.unsafe<Row>("SELECT * FROM movie_collections WHERE id=?", [id]);
        return rows[0] ? record(rows[0]) : null;
      }),
    );
  const replaceTmdbCollectionMembership: CollectionRepositories["replaceTmdbCollectionMembership"] =
    (input) =>
      run(
        "replaceTmdbCollectionMembership",
        Effect.gen(function* () {
          const guard = `EXISTS(SELECT 1 FROM source_items si JOIN upstream_servers us ON us.id=si.server_id WHERE si.id=? AND si.server_generation=? AND us.generation=si.server_generation AND us.enabled=1 AND us.deleted_at_ms IS NULL AND us.health='healthy' AND si.catalog_namespace=us.catalog_namespace AND si.quarantine_reason IS NULL AND si.item_type='Movie') AND NOT EXISTS(SELECT 1 FROM collection_membership_updates WHERE source_item_id=? AND server_generation=? AND updated_at_ms>?)`;
          const key = `tmdb:${input.sourceItemId}`,
            gp = [
              input.sourceItemId,
              input.expectedGeneration,
              input.sourceItemId,
              input.expectedGeneration,
              input.observedAtMs,
            ];
          if (!(yield* sql.unsafe(`SELECT 1 WHERE ${guard}`, gp)).length) return false;
          const commands: Command[] = [];
          if (input.tmdbCollectionId) {
            if (
              !(yield* sql.unsafe("SELECT 1 FROM movie_collections WHERE id=?", [
                tmdbId(input.tmdbCollectionId),
              ])).length
            )
              return false;
            commands.push({
              statement: `INSERT INTO collection_members(collection_id,evidence_key,source_item_id,canonical_id,evidence_type,collection_source_id,server_generation,updated_at_ms) SELECT ?,?,id,canonical_id,'tmdb',NULL,server_generation,? FROM source_items WHERE id=? AND ${guard} ON CONFLICT(evidence_key,source_item_id) DO UPDATE SET collection_id=excluded.collection_id,canonical_id=excluded.canonical_id,server_generation=excluded.server_generation,updated_at_ms=excluded.updated_at_ms`,
              params: [
                tmdbId(input.tmdbCollectionId),
                key,
                input.observedAtMs,
                input.sourceItemId,
                ...gp,
              ],
            });
          } else
            commands.push({
              statement: `DELETE FROM collection_members WHERE evidence_key=? AND source_item_id=? AND ${guard}`,
              params: [key, input.sourceItemId, ...gp],
            });
          commands.push(
            {
              statement: `INSERT INTO collection_membership_updates(source_item_id,server_generation,updated_at_ms) SELECT ?,?,? WHERE ${guard} ON CONFLICT(source_item_id) DO UPDATE SET server_generation=excluded.server_generation,updated_at_ms=excluded.updated_at_ms`,
              params: [input.sourceItemId, input.expectedGeneration, input.observedAtMs, ...gp],
            },
            revision,
          );
          yield* sql.batch(commands);
          return true;
        }),
      );
  const writeCollectionSnapshot: CollectionRepositories["writeCollectionSnapshot"] = (input) =>
    run(
      "writeCollectionSnapshot",
      Effect.gen(function* () {
        const id = yield* resolve(input.collectionId),
          key = sourceKey(input.source);
        const guard = `${fence} AND EXISTS(SELECT 1 FROM collection_sources WHERE id=? AND collection_id=? AND updated_at_ms<=?)`;
        const gp = [...fenceParams(input.source), key, id, input.observedAtMs];
        if (!(yield* sql.unsafe(`SELECT 1 WHERE ${guard}`, gp)).length) return false;
        const commands: Command[] = [];
        if (input.complete)
          commands.push({
            statement: `DELETE FROM collection_members WHERE evidence_key=? AND ${guard}`,
            params: [key, ...gp],
          });
        for (const member of input.members)
          commands.push({
            statement: `INSERT INTO collection_members(collection_id,evidence_key,source_item_id,canonical_id,evidence_type,collection_source_id,server_generation,updated_at_ms) SELECT ?,?,si.id,si.canonical_id,'boxset',?,?,? FROM source_items si WHERE si.id=? AND si.server_id=? AND si.server_generation=? AND si.item_type='Movie' AND si.quarantine_reason IS NULL AND si.canonical_id IS NOT NULL AND ${guard} ON CONFLICT(evidence_key,source_item_id) DO UPDATE SET collection_id=excluded.collection_id,canonical_id=excluded.canonical_id,server_generation=excluded.server_generation,updated_at_ms=excluded.updated_at_ms`,
            params: [
              id,
              key,
              key,
              input.source.serverGeneration,
              input.observedAtMs,
              member.sourceItemId,
              input.source.serverId,
              input.source.serverGeneration,
              ...gp,
            ],
          });
        commands.push(
          {
            statement: `UPDATE collection_sources SET updated_at_ms=? WHERE id=? AND ${guard}`,
            params: [input.observedAtMs, key, ...gp],
          },
          revision,
        );
        yield* sql.batch(commands);
        return true;
      }),
    );
  const readCollection: CollectionRepositories["readCollection"] = (id, scope) =>
    run(
      "readCollection",
      Effect.gen(function* () {
        const active = yield* resolve(id);
        if ((yield* readCollectionMovies(active, scope)).length === 0) return null;
        const rows = yield* sql.unsafe<Row>("SELECT * FROM movie_collections WHERE id=?", [active]);
        return rows[0] ? record(rows[0]) : null;
      }),
    );
  const listVisibleCollections: CollectionRepositories["listVisibleCollections"] = (scope) =>
    run(
      "listVisibleCollections",
      Effect.gen(function* () {
        const rows = yield* sql.unsafe<Row>(
          `SELECT mc.* FROM movie_collections mc WHERE EXISTS(SELECT 1 FROM collection_members cm JOIN source_items si ON si.id=cm.source_item_id JOIN upstream_servers us ON us.id=si.server_id WHERE cm.collection_id=mc.id AND ${eligible}) ORDER BY mc.id`,
          scopeParams(scope),
        );
        return rows.map(record);
      }),
    );
  const readCollectionSources: CollectionRepositories["readCollectionSources"] = (id, scope) =>
    run(
      "readCollectionSources",
      Effect.gen(function* () {
        const active = yield* resolve(id);
        const rows = yield* sql.unsafe<{
          server_id: string;
          catalog_namespace: string;
          server_generation: number;
          upstream_boxset_id: string;
          metadata_json: string;
        }>(
          `SELECT cs.* FROM collection_sources cs JOIN upstream_servers us ON us.id=cs.server_id WHERE cs.collection_id=? AND ${fence.replaceAll("id=?", "id=cs.server_id").replace("catalog_namespace=?", "catalog_namespace=cs.catalog_namespace").replace("generation=?", "generation=cs.server_generation")} AND EXISTS(SELECT 1 FROM library_sources ls JOIN virtual_libraries vl ON vl.id=ls.virtual_library_id WHERE ls.server_id=cs.server_id AND ls.enabled=1 AND vl.enabled=1 AND vl.media_type='movies' AND (? IS NULL OR vl.id=?)) ORDER BY cs.id`,
          [active, ...scopeParams(scope)],
        );
        return rows.map((r) => ({
          serverId: r.server_id,
          catalogNamespace: r.catalog_namespace,
          serverGeneration: r.server_generation,
          upstreamBoxSetId: r.upstream_boxset_id,
          metadata: JSON.parse(r.metadata_json) as JsonValue,
        }));
      }),
    );
  return {
    upsertCollection,
    replaceTmdbCollectionMembership,
    writeCollectionSnapshot,
    readCollection,
    readCollectionMovies,
    listVisibleCollections,
    readCollectionSources,
    readCollectionRevision: () =>
      run(
        "readCollectionRevision",
        Effect.map(
          sql.unsafe<{ revision: number }>(
            "SELECT revision FROM collection_revision WHERE singleton=1",
          ),
          (rows) => rows[0]?.revision ?? 0,
        ),
      ),
  };
};
