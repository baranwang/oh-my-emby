import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { makeLibraryCoverRepositories } from "../src/core/library-cover-repositories.js";
it("samples cached candidates before applying the limit instead of always selecting the lowest IDs", async () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE source_items(canonical_id TEXT,server_id TEXT,source_library_id TEXT,server_generation INTEGER,quarantine_reason TEXT,item_type TEXT);
    CREATE TABLE library_sources(virtual_library_id TEXT,server_id TEXT,source_library_id TEXT,enabled INTEGER);
    CREATE TABLE upstream_servers(id TEXT,enabled INTEGER,deleted_at_ms INTEGER,generation INTEGER,health TEXT);
    INSERT INTO library_sources VALUES('lib','s','movies',1);
    INSERT INTO upstream_servers VALUES('s',1,NULL,1,'healthy');`);
  for (let i = 0; i < 30; i++)
    db.run("INSERT INTO source_items VALUES(?,'s','movies',1,NULL,'Movie')", [
      `movie-${String(i).padStart(2, "0")}`,
    ]);
  const repo = makeLibraryCoverRepositories({
    unsafe: <A extends object>(sql: string, params: ReadonlyArray<unknown> = []) =>
      Effect.sync(() => db.query(sql).all(...(params as never[])) as A[]),
    batch: () => Effect.void,
  });
  try {
    const first = await Effect.runPromise(repo.listLibraryCoverCandidateIds("lib", 5));
    const draws = [];
    for (let i = 0; i < 5; i++)
      draws.push(await Effect.runPromise(repo.listLibraryCoverCandidateIds("lib", 5)));
    expect(first).toHaveLength(5);
    expect(draws.every((draw) => draw.length === 5 && new Set(draw).size === 5)).toBe(true);
    expect(draws.some((draw) => JSON.stringify(draw) !== JSON.stringify(first))).toBe(true);
  } finally {
    db.close();
  }
});
