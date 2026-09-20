import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Deferred, Effect, Fiber, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  Auth,
  makeAuthLayer,
  type DashboardSession
} from "../src/core/auth.js"
import { DASHBOARD_SESSION_IDLE_MS, PBKDF2_ITERATIONS } from "../src/core/limits.js"
import { Repositories } from "../src/core/repositories.js"
import { makeSqliteRepositoriesLayer } from "../src/platform/bun/sqlite-repositories.js"

const migration = await Bun.file(new URL("../migrations/0001_initial.sql", import.meta.url)).text()
const credentials = { username: "owner", password: "valid password" }

describe("local authentication", () => {
  let directory: string
  let filename: string
  let nowMs: number
  let layer: Layer.Layer<Auth | Repositories>

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "oh-my-emby-auth-"))
    filename = join(directory, "auth.sqlite")
    const database = new Database(filename)
    database.exec(migration)
    database.close()
    nowMs = 1_000_000
    const repositories = makeSqliteRepositoriesLayer({ filename })
    layer = Layer.merge(repositories, makeAuthLayer({ now: () => nowMs }).pipe(Layer.provide(repositories)))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  const run = <A, E>(effect: Effect.Effect<A, E, Auth | Repositories>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))

  const claim = () => run(Effect.gen(function*() {
    const auth = yield* Auth
    return yield* auth.claim(credentials, { scopeKey: "claim:127.0.0.1" })
  }))

  it("allows only one of two simultaneous first claims", async () => {
    const results = await Promise.all([
      Effect.runPromise(Effect.gen(function*() {
        const auth = yield* Auth
        return yield* auth.claim(credentials, { scopeKey: "claim:a" })
      }).pipe(Effect.result, Effect.provide(layer))),
      Effect.runPromise(Effect.gen(function*() {
        const auth = yield* Auth
        return yield* auth.claim({ username: "other", password: "another password" }, { scopeKey: "claim:b" })
      }).pipe(Effect.result, Effect.provide(layer)))
    ])

    expect(results.filter((result) => result._tag === "Success")).toHaveLength(1)
    const loser = results.find((result) => result._tag === "Failure")
    expect(loser?._tag).toBe("Failure")
    if (loser?._tag === "Failure") expect(loser.failure._tag).toBe("AlreadyInitialized")
    expect(await run(Effect.gen(function*() {
      const auth = yield* Auth
      return (yield* auth.bootstrap()).initialized
    }))).toBe(true)
  })

  it("keeps the instance initialized when first-server setup fails", async () => {
    await claim()
    await expect(run(Effect.fail(new Error("unreachable upstream")))).rejects.toThrow("unreachable upstream")
    expect(await run(Effect.gen(function*() {
      const auth = yield* Auth
      return yield* auth.bootstrap()
    }))).toEqual({ initialized: true })
  })

  it("stores PBKDF2 parameters and only hashes of issued tokens", async () => {
    const session = await claim()
    const database = new Database(filename, { readonly: true })
    const user = database.query<{
      password_hash: Uint8Array
      password_salt: Uint8Array
      pbkdf2_iterations: number
    }, []>("SELECT password_hash, password_salt, pbkdf2_iterations FROM users").get()!
    const stored = database.query<{ token_hash: Uint8Array }, []>(
      "SELECT token_hash FROM dashboard_sessions"
    ).get()!
    database.close()

    expect(user.password_hash).toHaveLength(32)
    expect(user.password_salt).toHaveLength(16)
    expect(user.pbkdf2_iterations).toBe(PBKDF2_ITERATIONS)
    expect(stored.token_hash).toHaveLength(32)
    expect(Buffer.from(stored.token_hash).toString("base64url")).not.toBe(session.token)
  })

  it("rejects invalid credentials", async () => {
    await claim()
    await expect(run(Effect.gen(function*() {
      const auth = yield* Auth
      return yield* auth.loginDashboard(
        { username: "owner", password: "wrong password" },
        { scopeKey: "dashboard:invalid" }
      )
    }))).rejects.toMatchObject({ _tag: "InvalidCredentials" })
  })

  it("fences a login that verified the old password", async () => {
    await claim()
    const result = await run(Effect.gen(function*() {
      const auth = yield* Auth
      const current = yield* auth.loginDashboard(credentials, { scopeKey: "dashboard:current" })
      const principal = yield* auth.authenticateDashboard(current.token)
      const gate = yield* Deferred.make<void>()
      const login = yield* auth.loginDashboard(credentials, {
        scopeKey: "dashboard:racing",
        afterVerify: Deferred.await(gate)
      }).pipe(Effect.result, Effect.forkChild)
      yield* auth.changePassword(principal, {
        currentPassword: credentials.password,
        newPassword: "new valid password"
      })
      yield* Deferred.succeed(gate, undefined)
      return yield* Fiber.join(login)
    }))

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure._tag).toBe("AuthenticationChanged")
  })

  it("uses a rolling seven-day Dashboard inactivity window", async () => {
    const session = await claim()
    nowMs += DASHBOARD_SESSION_IDLE_MS / 2 + 1
    await expect(run(Effect.gen(function*() {
      const auth = yield* Auth
      return yield* auth.authenticateDashboard(session.token)
    }))).resolves.toMatchObject({ username: "owner" })

    nowMs += DASHBOARD_SESSION_IDLE_MS - 1
    await expect(run(Effect.gen(function*() {
      const auth = yield* Auth
      return yield* auth.authenticateDashboard(session.token)
    }))).resolves.toMatchObject({ username: "owner" })

    nowMs += DASHBOARD_SESSION_IDLE_MS + 1
    await expect(run(Effect.gen(function*() {
      const auth = yield* Auth
      return yield* auth.authenticateDashboard(session.token)
    }))).rejects.toMatchObject({ _tag: "InvalidCredentials" })
  })

  it("logs out only the current Dashboard session", async () => {
    const first = await claim()
    const second = await run(Effect.gen(function*() {
      const auth = yield* Auth
      return yield* auth.loginDashboard(credentials, { scopeKey: "dashboard:second" })
    }))
    await run(Effect.gen(function*() {
      const auth = yield* Auth
      const principal = yield* auth.authenticateDashboard(first.token)
      yield* auth.logoutDashboard(principal)
    }))

    await expect(run(Effect.gen(function*() {
      const auth = yield* Auth
      return yield* auth.authenticateDashboard(first.token)
    }))).rejects.toMatchObject({ _tag: "InvalidCredentials" })
    await expect(run(Effect.gen(function*() {
      const auth = yield* Auth
      return yield* auth.authenticateDashboard(second.token)
    }))).resolves.toMatchObject({ username: "owner" })
  })

  it("password change atomically revokes Dashboard sessions and Emby tokens", async () => {
    const dashboard = await claim()
    const emby = await run(Effect.gen(function*() {
      const auth = yield* Auth
      return yield* auth.loginEmby({
        ...credentials,
        deviceId: "senplayer-device",
        deviceName: "SenPlayer"
      }, { scopeKey: "emby:device" })
    }))
    await run(Effect.gen(function*() {
      const auth = yield* Auth
      const principal = yield* auth.authenticateDashboard(dashboard.token)
      yield* auth.changePassword(principal, {
        currentPassword: credentials.password,
        newPassword: "new valid password"
      })
    }))

    for (const effect of [
      Effect.gen(function*() {
        const auth = yield* Auth
        return yield* auth.authenticateDashboard(dashboard.token)
      }),
      Effect.gen(function*() {
        const auth = yield* Auth
        return yield* auth.authenticateEmby(emby.accessToken)
      })
    ]) {
      await expect(run(effect)).rejects.toMatchObject({ _tag: "InvalidCredentials" })
    }
    await expect(run(Effect.gen(function*() {
      const auth = yield* Auth
      return yield* auth.loginDashboard(credentials, { scopeKey: "dashboard:old" })
    }))).rejects.toMatchObject({ _tag: "InvalidCredentials" })
  })

  it("persists and enforces failed-login rate limits", async () => {
    await claim()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(run(Effect.gen(function*() {
        const auth = yield* Auth
        return yield* auth.loginDashboard(
          { username: "owner", password: "wrong password" },
          { scopeKey: "dashboard:rate-limited" }
        )
      }))).rejects.toMatchObject({ _tag: "InvalidCredentials" })
    }
    await expect(run(Effect.gen(function*() {
      const auth = yield* Auth
      return yield* auth.loginDashboard(credentials, { scopeKey: "dashboard:rate-limited" })
    }))).rejects.toMatchObject({ _tag: "RateLimited" })

    const repositories = makeSqliteRepositoriesLayer({ filename })
    const restarted = Layer.merge(
      repositories,
      makeAuthLayer({ now: () => nowMs }).pipe(Layer.provide(repositories))
    )
    await expect(Effect.runPromise(Effect.gen(function*() {
      const auth = yield* Auth
      return yield* auth.loginDashboard(credentials, { scopeKey: "dashboard:rate-limited" })
    }).pipe(Effect.provide(restarted)))).rejects.toMatchObject({ _tag: "RateLimited" })
  })
})
