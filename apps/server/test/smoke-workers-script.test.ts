import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import benchmarkWorker from "../../../scripts/workers-pbkdf2-benchmark.js"

const script = resolve(import.meta.dirname, "../../../scripts/smoke-workers.sh")
const benchmarkScript = resolve(import.meta.dirname, "../../../scripts/benchmark-workers-pbkdf2.ts")

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
