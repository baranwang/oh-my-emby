import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import benchmarkWorker from "../../../scripts/workers-pbkdf2-benchmark.js"

const script = resolve(import.meta.dirname, "../../../scripts/smoke-workers.sh")
const benchmarkScript = resolve(import.meta.dirname, "../../../scripts/benchmark-workers-pbkdf2.ts")
const ownershipScript = resolve(import.meta.dirname, "../../../scripts/workers-smoke-ownership.ts")
const accountId = "a".repeat(32)
const apiToken = "cloudflare-api-token-secret"
const databaseId = "00000000-0000-4000-8000-000000000001"

const plan = (pathPrefix?: string) => {
  const result = Bun.spawnSync({
    cmd: ["bash", script, "--plan-remote"],
    env: {
      ...Bun.env,
      ...(pathPrefix ? { PATH: `${pathPrefix}:${Bun.env.PATH}` } : {}),
      WORKERS_STAGING_NAME: "existing-production-stage-backup",
      WORKERS_STAGING_ORIGIN: "https://production.example.com"
    },
    stdout: "pipe",
    stderr: "pipe"
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  return {
    raw: result.stdout.toString(),
    value: JSON.parse(result.stdout.toString()) as {
      mode: string
      runId: string
      worker: string
      database: string
      smokeOrigin: { source: string; expectedWorker: string }
      benchmark: {
        entrypoint: string
        runner: string
        method: string
        targetWorker: string
        authorization: string
        measurement: string
      }
      cleanup: { worker: string; database: string }
    }
  }
}

type RemoteScenario = "existing" | "ambiguous" | "mixed-not-found" | "duplicate-not-found" | "empty-not-found" |
  "malformed-not-found" | "deploy-failure" | "missing-ownership" | "wrong-ownership" | "verified"

interface FakeState {
  readonly deploys?: ReadonlyArray<string>
  readonly ownershipToken?: string
  readonly benchmarkToken?: string
  readonly runId?: string
}

const readJsonLines = async (path: string): Promise<ReadonlyArray<ReadonlyArray<string>>> => {
  const file = Bun.file(path)
  if (!(await file.exists())) return []
  return (await file.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

const runRemoteScenario = async (scenario: RemoteScenario) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ome-remote-smoke-"))
  const fakeWrangler = join(temporaryDirectory, "wrangler")
  const commandLog = join(temporaryDirectory, "commands.jsonl")
  const statePath = join(temporaryDirectory, "state.json")
  const requests: Array<string> = []

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      requests.push(`${request.method} ${url.pathname}`)

      if (url.pathname.startsWith("/client/v4/") && request.headers.get("authorization") !== `Bearer ${apiToken}`) {
        return Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 401 })
      }

      if (request.method === "GET" && url.pathname.startsWith(`/client/v4/accounts/${accountId}/workers/scripts/`)) {
        if (scenario === "existing") return Response.json({ success: true, result: { id: "pre-existing" } })
        if (scenario === "ambiguous") return Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 500 })
        if (scenario === "mixed-not-found") {
          return Response.json({ success: false, errors: [{ code: 10007 }, { code: 10000 }] }, { status: 404 })
        }
        if (scenario === "duplicate-not-found") {
          return Response.json({ success: false, errors: [{ code: 10007 }, { code: 10007 }] }, { status: 404 })
        }
        if (scenario === "empty-not-found") return Response.json({ success: false, errors: [] }, { status: 404 })
        if (scenario === "malformed-not-found") return Response.json({ success: false, errors: {} }, { status: 404 })
        return Response.json({ success: false, errors: [{ code: 10007, message: "script not found" }], result: null }, { status: 404 })
      }
      if (request.method === "DELETE" && url.pathname.startsWith(`/client/v4/accounts/${accountId}/workers/scripts/`)) {
        return Response.json({ success: true, errors: [], messages: [], result: null })
      }
      if (request.method === "DELETE" && url.pathname === `/client/v4/accounts/${accountId}/d1/database/${databaseId}`) {
        return Response.json({ success: true, errors: [], messages: [], result: null })
      }
      if (url.pathname.startsWith("/client/v4/")) {
        return Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 500 })
      }

      if (request.method === "GET" && url.pathname === "/__ome-smoke-ownership") {
        if (scenario === "missing-ownership") return new Response(null, { status: 404 })
        const state = await Bun.file(statePath).json() as FakeState
        if (scenario === "wrong-ownership") {
          return Response.json({ runId: "wrong-run" }, { headers: { "cache-control": "private, no-store" } })
        }
        const ownershipWorker = (await import(`${ownershipScript}?scenario=${Date.now()}`)).default
        return ownershipWorker.fetch(request, {
          SMOKE_RUN_ID: state.runId,
          SMOKE_OWNERSHIP_TOKEN: state.ownershipToken
        })
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ status: "ok" })
      }
      if (request.method === "GET" && url.pathname === "/dashboard/servers") {
        return new Response("<!doctype html><title>Dashboard</title>", { headers: { "content-type": "text/html; charset=utf-8" } })
      }
      if (request.method === "POST" && url.pathname === "/api/dashboard/claim") {
        return Response.json({ authenticated: true }, { headers: { "set-cookie": "ome_session=fake; Path=/api/dashboard; HttpOnly" } })
      }
      if (request.method === "GET" && url.pathname === "/api/dashboard/session") {
        return Response.json({ authenticated: true })
      }
      if (request.method === "POST" && url.pathname === "/__pbkdf2") {
        const state = await Bun.file(statePath).json() as FakeState
        return benchmarkWorker.fetch(request, {
          BENCHMARK_TOKEN: state.benchmarkToken,
          BENCHMARK_COMPATIBILITY_DATE: "2026-09-20"
        })
      }
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } })
    }
  })
  const fakeOrigin = `http://127.0.0.1:${server.port}`

  const fakeWranglerSource = `#!/usr/bin/env bun
const args = Bun.argv.slice(2)
const logPath = Bun.env.FAKE_WRANGLER_LOG
const priorLog = await Bun.file(logPath).exists() ? await Bun.file(logPath).text() : ""
await Bun.write(logPath, priorLog + JSON.stringify(args) + "\\n")
const configIndex = args.indexOf("--config")
const configPath = configIndex === -1 ? "" : args[configIndex + 1]
const readConfig = async () => await Bun.file(configPath).json()
const readState = async () => await Bun.file(Bun.env.FAKE_STATE_PATH).exists()
  ? await Bun.file(Bun.env.FAKE_STATE_PATH).json()
  : {}

if (args.includes("d1") && args.includes("create")) {
  const config = await readConfig()
  const name = args[args.indexOf("create") + 1]
  config.d1_databases = [{ binding: "DB", database_name: name, database_id: "${databaseId}" }]
  await Bun.write(configPath, JSON.stringify(config, null, 2))
  console.log("Created D1 database", name)
  process.exit(0)
}
if (args.includes("d1") && args.includes("migrations") && args.includes("apply")) {
  process.exit(0)
}
if (args.includes("deploy")) {
  const config = await readConfig()
  const state = await readState()
  state.deploys = [...(state.deploys ?? []), config.main]
  if (config.main.endsWith("/scripts/workers-smoke-ownership.ts")) {
    if (Bun.env.FAKE_SCENARIO === "deploy-failure") {
      await Bun.write(Bun.env.FAKE_STATE_PATH, JSON.stringify(state))
      console.error("simulated ownership deploy failure")
      process.exit(41)
    }
    const secretsPath = args[args.indexOf("--secrets-file") + 1]
    const secrets = await Bun.file(secretsPath).json()
    state.ownershipToken = secrets.SMOKE_OWNERSHIP_TOKEN
    state.runId = config.vars.SMOKE_RUN_ID
  } else if (config.main.endsWith("/scripts/workers-pbkdf2-benchmark.ts")) {
    const secretsPath = args[args.indexOf("--secrets-file") + 1]
    const secrets = await Bun.file(secretsPath).json()
    state.benchmarkToken = secrets.BENCHMARK_TOKEN
  }
  await Bun.write(Bun.env.FAKE_STATE_PATH, JSON.stringify(state))
  console.log("Deployed", Bun.env.FAKE_WORKER_ORIGIN)
  process.exit(0)
}
console.error("unexpected fake Wrangler invocation", JSON.stringify(args))
process.exit(42)
`
  await writeFile(fakeWrangler, fakeWranglerSource)
  await chmod(fakeWrangler, 0o755)

  try {
    const child = Bun.spawn({
      cmd: ["bash", script, "--remote"],
      env: {
        ...Bun.env,
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: apiToken,
        CLOUDFLARE_API_BASE_URL: `${fakeOrigin}/client/v4`,
        WORKERS_SMOKE_API_BASE_URL: `${fakeOrigin}/client/v4`,
        WORKERS_SMOKE_WRANGLER: fakeWrangler,
        FAKE_SCENARIO: scenario,
        FAKE_STATE_PATH: statePath,
        FAKE_WRANGLER_LOG: commandLog,
        FAKE_WORKER_ORIGIN: fakeOrigin,
        WORKERS_STAGING_NAME: "existing-production-stage-backup",
        WORKERS_STAGING_ORIGIN: "https://production.example.com"
      },
      stdout: "pipe",
      stderr: "pipe"
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    const stateFile = Bun.file(statePath)
    return {
      exitCode,
      stdout,
      stderr,
      requests: [...requests],
      commands: await readJsonLines(commandLog),
      state: await stateFile.exists() ? await stateFile.json() as FakeState : {}
    }
  } finally {
    server.stop(true)
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

const workerResource = (requests: ReadonlyArray<string>) => {
  const request = requests.find((value) => value.startsWith(`GET /client/v4/accounts/${accountId}/workers/scripts/`))
  expect(request).toBeDefined()
  return request!.slice(request!.lastIndexOf("/") + 1)
}

const workerDeletes = (requests: ReadonlyArray<string>) => requests.filter((value) =>
  value.startsWith(`DELETE /client/v4/accounts/${accountId}/workers/scripts/`))

const d1Deletes = (requests: ReadonlyArray<string>) => requests.filter((value) =>
  value === `DELETE /client/v4/accounts/${accountId}/d1/database/${databaseId}`)

describe.sequential("Workers remote smoke ownership", () => {
  it.each([
    "existing",
    "ambiguous",
    "mixed-not-found",
    "duplicate-not-found",
    "empty-not-found",
    "malformed-not-found"
  ] as const)("aborts on %s preflight without deploy or cleanup", async (scenario) => {
    const result = await runRemoteScenario(scenario)

    expect(result.exitCode).not.toBe(0)
    expect(workerResource(result.requests)).toMatch(/^ome-worker-[a-f0-9]{32}$/)
    expect(result.commands).toEqual([])
    expect(workerDeletes(result.requests)).toEqual([])
    expect(d1Deletes(result.requests)).toEqual([])
  }, 30_000)

  it("does not delete a Worker after an ownership-probe deploy failure", async () => {
    const result = await runRemoteScenario("deploy-failure")
    const worker = workerResource(result.requests)

    expect(result.exitCode).not.toBe(0)
    expect(result.commands.filter((args) => args.includes("deploy"))).toHaveLength(1)
    expect(workerDeletes(result.requests)).toEqual([])
    expect(d1Deletes(result.requests)).toHaveLength(1)
    expect(result.stderr).toContain(`Manual cleanup may be required for Worker ${worker}`)
  }, 30_000)

  it.each(["missing-ownership", "wrong-ownership"] as const)("does not delete a Worker after a %s response", async (scenario) => {
    const result = await runRemoteScenario(scenario)
    const worker = workerResource(result.requests)

    expect(result.exitCode).not.toBe(0)
    expect(result.commands.filter((args) => args.includes("deploy"))).toHaveLength(1)
    expect(workerDeletes(result.requests)).toEqual([])
    expect(d1Deletes(result.requests)).toHaveLength(1)
    expect(result.stderr).toContain(`Manual cleanup may be required for Worker ${worker}`)
  }, 30_000)

  it("deletes only the verified run-owned Worker and created D1 ID without leaking secrets", async () => {
    const result = await runRemoteScenario("verified")
    const worker = workerResource(result.requests)
    const workerDeletePath = `DELETE /client/v4/accounts/${accountId}/workers/scripts/${worker}`

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.commands.filter((args) => args.includes("deploy"))).toHaveLength(3)
    expect(workerDeletes(result.requests)).toEqual([workerDeletePath])
    expect(d1Deletes(result.requests)).toHaveLength(1)
    expect(worker).toMatch(/^ome-worker-[a-f0-9]{32}$/)
    const publicSurface = JSON.stringify({
      stdout: result.stdout,
      stderr: result.stderr,
      requests: result.requests,
      commands: result.commands
    })
    expect(publicSurface).not.toContain("existing-production-stage-backup")
    expect(publicSurface).not.toContain("production.example.com")
    expect(result.state.ownershipToken).toMatch(/^[a-f0-9]{64}$/)
    expect(result.state.benchmarkToken).toMatch(/^[a-f0-9]{64}$/)
    expect(publicSurface).not.toContain(apiToken)
    expect(publicSurface).not.toContain(result.state.ownershipToken!)
    expect(publicSurface).not.toContain(result.state.benchmarkToken!)
  }, 30_000)
})

describe("Workers remote smoke plan", () => {
  it("uses unique run-owned targets without leaking temporary state", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "ome-plan-"))
    const bin = join(temporaryDirectory, "bin")
    await mkdir(bin)
    await writeFile(join(bin, "mktemp"), "#!/bin/sh\nexit 93\n")
    await chmod(join(bin, "mktemp"), 0o755)

    try {
      const first = plan(bin)
      const second = plan(bin)
      for (const { raw, value } of [first, second]) {
        expect(value).toEqual({
          mode: "remote-plan",
          runId: expect.stringMatching(/^[a-f0-9]{32}$/),
          worker: `ome-worker-${value.runId}`,
          database: `ome-d1-${value.runId}`,
          smokeOrigin: {
            source: "wrangler-deploy-output",
            expectedWorker: value.worker
          },
          benchmark: {
            entrypoint: "scripts/workers-pbkdf2-benchmark.ts",
            runner: "scripts/benchmark-workers-pbkdf2.ts",
            method: "POST",
            targetWorker: value.worker,
            authorization: "ephemeral-run-token",
            measurement: "remote-request-upper-bound"
          },
          cleanup: {
            worker: value.worker,
            database: value.database
          }
        })
        expect(raw).not.toContain("existing-production-stage-backup")
        expect(raw).not.toContain("production.example.com")
      }
      expect(second.value.runId).not.toBe(first.value.runId)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it("measures ten authenticated Worker derivations from the caller", async () => {
    let requests = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        requests++
        return benchmarkWorker.fetch(request, {
          BENCHMARK_TOKEN: "ephemeral-token",
          BENCHMARK_COMPATIBILITY_DATE: "2026-09-20"
        })
      }
    })

    try {
      const child = Bun.spawn({
        cmd: [process.execPath, benchmarkScript],
        env: {
          ...Bun.env,
          WORKERS_BENCHMARK_ORIGIN: `http://127.0.0.1:${server.port}`,
          WORKERS_BENCHMARK_TOKEN: "ephemeral-token"
        },
        stdout: "pipe",
        stderr: "pipe"
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])

      expect(exitCode, stderr).toBe(0)
      expect(requests).toBe(10)
      expect(JSON.parse(stdout)).toMatchObject({
        runtime: "Cloudflare Workers",
        measurement: "remote-request-upper-bound",
        compatibilityDate: "2026-09-20",
        iterations: 310_000,
        runs: 10,
        warmupRunsDiscarded: 1,
        gateMs: 250,
        passed: true
      })
    } finally {
      server.stop(true)
    }
  })
})
