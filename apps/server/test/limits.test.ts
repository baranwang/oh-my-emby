import { describe, expect, it } from "vitest"
import {
  DB_BATCH_SIZE,
  MAX_CONFIGURED_UPSTREAMS,
  MAX_FANOUT_CONCURRENCY,
  MAX_MATERIALIZED_ITEMS,
  MAX_PAGE_SIZE,
  PBKDF2_ITERATIONS
} from "../src/core/limits.js"

describe("bounded core", () => {
  it("keeps public and database work inside explicit ceilings", () => {
    expect(MAX_CONFIGURED_UPSTREAMS).toBe(10)
    expect(MAX_FANOUT_CONCURRENCY).toBeLessThanOrEqual(MAX_CONFIGURED_UPSTREAMS)
    expect(MAX_PAGE_SIZE).toBe(100)
    expect(MAX_MATERIALIZED_ITEMS).toBeGreaterThanOrEqual(MAX_PAGE_SIZE)
    expect(DB_BATCH_SIZE).toBeLessThanOrEqual(100)
    expect(PBKDF2_ITERATIONS).toBe(310_000)
  })
})
