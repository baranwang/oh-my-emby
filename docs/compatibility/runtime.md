# Runtime compatibility evidence

Release gates distinguish local automation from remote runtime evidence. A successful build is not a runtime measurement.

## PBKDF2-SHA-256

The authentication cost is defined once by `PBKDF2_ITERATIONS` in `apps/server/src/core/limits.ts`. Each benchmark performs ten real derivations, discards the first, reports p50/p95, rejects zero/non-finite samples, and exits nonzero when p95 is 250 ms or higher.

```sh
bun scripts/benchmark-pbkdf2.ts
```

| Target | Measurement | Timestamp | Runtime | Iterations | p50 | p95 | Gate |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| Local Bun | in-process | 2026-09-21T02:05:47+08:00 | Bun 1.4.2 | 310,000 | 17.84 ms | 18.96 ms | PASS |
| Deployed Worker | remote request upper bound | UNEXECUTED | Cloudflare Workers | 310,000 | UNEXECUTED | UNEXECUTED | UNEXECUTED |

Remote Worker measurement is deliberately **UNEXECUTED** in Task 15 because remote Cloudflare side effects were not authorized. Deployed Workers deliberately freeze high-resolution timers while CPU-only code runs, so the temporary Worker performs one untimed derivation per authenticated request and `scripts/benchmark-workers-pbkdf2.ts` measures ten requests from the caller. The recorded value is therefore a conservative end-to-end upper bound that includes network latency, not a fabricated CPU-only duration. `./scripts/smoke-workers.sh --remote` runs this benchmark after the application smoke and prints the result before deleting the run-owned resources.

If either target misses 250 ms, change only `PBKDF2_ITERATIONS`, then rerun authentication tests and both runtime benchmarks before release. Do not claim one target from the other target's result.

## Runtime smoke matrix

| Target | Evidence |
| --- | --- |
| Workers local workerd + local D1 | Run `./scripts/smoke-workers.sh` |
| Workers remote staging + ephemeral D1 | **UNEXECUTED**; the local fake-API integration proves fail-closed Worker ownership and exact-ID cleanup, but run the explicit `--remote` command for Cloudflare evidence |
| Docker/Bun + SQLite | Run `docker build -t oh-my-emby:verify . && ./scripts/smoke-docker.sh` |
| Real SenPlayer | **UNTESTED**; follow `docs/compatibility/senplayer.md` |
