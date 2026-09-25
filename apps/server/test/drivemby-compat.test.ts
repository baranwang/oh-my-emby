import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { expect, it } from "vitest"

import { makeSqlDrivembyCompat } from "../src/core/drivemby-compat.js"

const database = new Database(":memory:")
database.exec(`
  CREATE TABLE canonical_items (
    item_type TEXT NOT NULL,
    display_metadata_json TEXT NOT NULL
  );
  CREATE TABLE emby_tokens (
    id TEXT PRIMARY KEY,
    device_id TEXT,
    device_name TEXT,
    last_used_at_ms INTEGER
  );
`)
database.run(
  "INSERT INTO canonical_items (item_type, display_metadata_json) VALUES (?, ?)",
  ["Movie", JSON.stringify({ Genres: ["Drama", "Drama"] })]
)
database.run(
  "INSERT INTO canonical_items (item_type, display_metadata_json) VALUES (?, ?)",
  ["Series", JSON.stringify({ Genres: ["Comedy"] })]
)
database.run(
  "INSERT INTO canonical_items (item_type, display_metadata_json) VALUES (?, ?)",
  ["Episode", JSON.stringify({ Genres: ["Drama"] })]
)

const compat = await Effect.runPromise(makeSqlDrivembyCompat({
  unsafe: <A extends object>(statement: string, params: ReadonlyArray<unknown> = []) =>
    Effect.sync(() => database.query(statement).all(...(params as never[])) as Array<A>)
}))

it("counts canonical items, pages genres, and keeps one history row per session", async () => {
  expect(await Effect.runPromise(compat.counts())).toEqual({
    MovieCount: 1,
    SeriesCount: 1,
    EpisodeCount: 1,
    ItemCount: 3
  })
  expect(await Effect.runPromise(compat.genres(0, 1))).toEqual({ names: ["Comedy"], total: 2 })

  const record = (session: string, kind: "start" | "progress" | "stop", nowMs: number) =>
    Effect.runPromise(compat.recordPlayback({
      kind,
      playSessionId: session,
      canonicalId: "movie-1",
      itemName: "Example",
      mediaSourceId: "version-1",
      sourceName: "file.mkv",
      deviceName: "Phone",
      clientName: "SenPlayer",
      positionTicks: 10,
      runtimeTicks: 100,
      completed: kind === "stop",
      nowMs
    }))
  await record("session-1", "start", 2_000)
  await record("session-1", "start", 3_000)
  await record("session-1", "stop", 4_000)
  await record("session-2", "start", 1_000)
  const page = await Effect.runPromise(compat.listHistory({
    cursor: null,
    startIndex: 0,
    limit: 1,
    search: "exam",
    itemId: "movie-1"
  }))
  expect(page.total).toBe(2)
  expect(page.items).toHaveLength(1)
  expect(page.items[0]?.startedAtMs).toBe(2_000)
  expect(page.items[0]?.stoppedAtMs).toBe(4_000)
  expect(page.items[0]?.completed).toBe(true)
  expect(page.nextCursor).toEqual(expect.any(String))
  const next = await Effect.runPromise(compat.listHistory({
    cursor: { startedAtMs: page.items[0]!.startedAtMs, id: page.items[0]!.id },
    startIndex: 0,
    limit: 10,
    search: null,
    itemId: null
  }))
  expect(next.items.map((row) => row.startedAtMs)).toEqual([1_000])

  const created = await Effect.runPromise(compat.createConnection({
    name: "phone",
    password: "secret1",
    nowMs: 5_000
  }))
  expect(created?.password).toBe("secret1")
  expect(await Effect.runPromise(compat.verifyConnection("secret1"))).toBe(created!.id)
  expect(await Effect.runPromise(compat.verifyConnection("nope"))).toBeNull()
  const listed = await Effect.runPromise(compat.listConnections())
  expect(listed[0]?.name).toBe("phone")
  expect(JSON.stringify(listed)).not.toContain("secret1")
  expect(await Effect.runPromise(compat.deleteHistory(page.items[0]!.id))).toBe(true)
  await record("session-1", "progress", 6_000)
  const remaining = await Effect.runPromise(compat.listHistory({
    cursor: null,
    startIndex: 0,
    limit: 10,
    search: null,
    itemId: null
  }))
  expect(remaining.items.map((row) => row.startedAtMs)).toEqual([1_000])
})
