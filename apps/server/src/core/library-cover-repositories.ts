import { Effect } from "effect";
import type { CollectionSql } from "./collection-repositories.js";
import { RepositoryError } from "./errors.js";
import type {
  LibraryCoverRepositories,
  LibraryCoverRecord,
  LibraryCoverStoredSummary,
  LibraryCoverManifest,
} from "./library-cover-model.js";
interface Row {
  library_id: string;
  body?: Uint8Array | number[] | ArrayBuffer;
  revision: string;
  template_version: string;
  config_digest: string;
  width: 1920;
  height: 1080;
  updated_at_ms: number;
}
const view = (r: Row): LibraryCoverStoredSummary => ({
  libraryId: r.library_id,
  revision: r.revision,
  templateVersion: r.template_version,
  configDigest: r.config_digest,
  width: r.width,
  height: r.height,
  updatedAtMs: r.updated_at_ms,
});
const validManifest = `EXISTS (SELECT 1 FROM virtual_libraries l WHERE l.id=m.library_id AND l.enabled=1
 AND l.name=json_extract(m.config_digest,'$.name') AND l.media_type=json_extract(m.config_digest,'$.mediaType')
 AND (SELECT count(*) FROM library_sources b WHERE b.virtual_library_id=l.id)=json_array_length(m.config_digest,'$.sources')
 AND NOT EXISTS(SELECT 1 FROM json_each(m.config_digest,'$.sources') j WHERE NOT EXISTS(SELECT 1 FROM library_sources b WHERE b.virtual_library_id=l.id AND b.server_id=json_extract(j.value,'$.serverId') AND b.source_library_id=json_extract(j.value,'$.sourceLibraryId') AND b.enabled=json_extract(j.value,'$.enabled') AND b.source_order=json_extract(j.value,'$.sourceOrder'))))
 AND NOT EXISTS(SELECT 1 FROM json_each(m.fences_json) f WHERE NOT EXISTS(SELECT 1 FROM upstream_servers s WHERE s.id=json_extract(f.value,'$.serverId') AND s.generation=json_extract(f.value,'$.generation') AND s.enabled=1 AND s.deleted_at_ms IS NULL AND s.health='healthy' AND s.verified_base_url IS NOT NULL))`;
export function makeLibraryCoverRepositories(sql: CollectionSql): LibraryCoverRepositories {
  const db = <A>(e: Effect.Effect<A, unknown>) =>
    e.pipe(
      Effect.mapError(
        () =>
          new RepositoryError({
            operation: "library cover storage",
            message: "Library cover storage failed",
          }),
      ),
    );
  return {
    getLibraryCover: (id) =>
      db(
        sql.unsafe<Row>("SELECT * FROM library_covers WHERE library_id=?", [id]).pipe(
          Effect.map((rows) => {
            const r = rows[0];
            return r
              ? ({
                  ...view(r),
                  body:
                    r.body instanceof Uint8Array
                      ? Uint8Array.from(r.body)
                      : r.body instanceof ArrayBuffer
                        ? new Uint8Array(r.body)
                        : Uint8Array.from(r.body ?? []),
                } as LibraryCoverRecord)
              : null;
          }),
        ),
      ),
    listLibraryCoverSummaries: (ids) =>
      db(
        Effect.gen(function* () {
          const summaries: LibraryCoverStoredSummary[] = [];
          for (let offset = 0; offset < ids.length; offset += 100) {
            const batch = ids.slice(offset, offset + 100);
            const rows = yield* sql.unsafe<Row>(
              `SELECT library_id,revision,template_version,config_digest,width,height,updated_at_ms FROM library_covers WHERE library_id IN (${batch.map(() => "?").join(",")})`,
              batch,
            );
            summaries.push(...rows.map(view));
          }
          return summaries;
        }),
      ),
    saveLibraryCoverManifest: (m) =>
      db(
        sql
          .batch([
            {
              statement:
                "DELETE FROM library_cover_manifests WHERE library_id=? AND expires_at_ms<=?",
              params: [m.libraryId, Date.now()],
            },
            {
              statement: "INSERT INTO library_cover_manifests VALUES (?,?,?,?,?,?,?)",
              params: [
                m.token,
                m.libraryId,
                m.configDigest,
                JSON.stringify(m.serverFences),
                JSON.stringify(m.candidates),
                m.expectedRevision,
                m.expiresAtMs,
              ],
            },
            {
              statement:
                "DELETE FROM library_cover_manifests WHERE library_id=? AND token NOT IN (SELECT token FROM library_cover_manifests WHERE library_id=? ORDER BY expires_at_ms DESC, token DESC LIMIT 4)",
              params: [m.libraryId, m.libraryId],
            },
          ])
          .pipe(Effect.asVoid),
      ),
    getLibraryCoverManifest: (token) =>
      db(
        sql
          .unsafe<{
            token: string;
            library_id: string;
            config_digest: string;
            fences_json: string;
            candidates_json: string;
            expected_revision: string | null;
            expires_at_ms: number;
          }>("SELECT * FROM library_cover_manifests WHERE token=?", [token])
          .pipe(
            Effect.map((rows) => {
              const r = rows[0];
              return r
                ? ({
                    token: r.token,
                    libraryId: r.library_id,
                    configDigest: r.config_digest,
                    serverFences: JSON.parse(r.fences_json),
                    candidates: JSON.parse(r.candidates_json),
                    expectedRevision: r.expected_revision,
                    expiresAtMs: r.expires_at_ms,
                  } as LibraryCoverManifest)
                : null;
            }),
          ),
      ),
    commitLibraryCover: ({ token, cover: c, nowMs }) =>
      db(
        sql
          .unsafe<{ library_id: string }>(
            `INSERT INTO library_covers SELECT m.library_id,?,?,?,?,?,?,? FROM library_cover_manifests m WHERE m.token=? AND m.library_id=? AND m.expires_at_ms>? AND m.config_digest=? AND ${validManifest} AND m.expected_revision IS (SELECT revision FROM library_covers WHERE library_id=m.library_id)
 ON CONFLICT(library_id) DO UPDATE SET body=excluded.body,revision=excluded.revision,template_version=excluded.template_version,config_digest=excluded.config_digest,width=excluded.width,height=excluded.height,updated_at_ms=excluded.updated_at_ms RETURNING library_id`,
            [
              c.body,
              c.revision,
              c.templateVersion,
              c.configDigest,
              c.width,
              c.height,
              c.updatedAtMs,
              token,
              c.libraryId,
              nowMs,
              c.configDigest,
            ],
          )
          .pipe(Effect.map((r) => r.length > 0)),
      ),
    listLibraryCoverCandidateIds: (id, limit) =>
      db(
        sql
          .unsafe<{ canonical_id: string }>(
            `SELECT DISTINCT i.canonical_id FROM source_items i JOIN library_sources b ON b.server_id=i.server_id AND b.source_library_id=i.source_library_id JOIN upstream_servers s ON s.id=i.server_id WHERE b.virtual_library_id=? AND b.enabled=1 AND s.enabled=1 AND s.deleted_at_ms IS NULL AND s.generation=i.server_generation AND s.health='healthy' AND i.quarantine_reason IS NULL AND i.canonical_id IS NOT NULL AND i.item_type IN ('Movie','Series') ORDER BY RANDOM() LIMIT ?`,
            [id, limit],
          )
          .pipe(Effect.map((r) => r.map((x) => x.canonical_id))),
      ),
  };
}
