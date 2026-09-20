# Runtime compatibility evidence

Release gates distinguish local automation from remote runtime evidence. A successful build is not a runtime measurement.

## PBKDF2-SHA-256

The authentication cost is defined once by `PBKDF2_ITERATIONS` in `apps/server/src/core/limits.ts`. The benchmark performs ten real derivations, discards the first, reports p50/p95, and exits nonzero when p95 is 250 ms or higher.

```sh
bun scripts/benchmark-pbkdf2.ts
```

| Target | Timestamp | Runtime | Iterations | p50 | p95 | Gate |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Local Bun | 2026-09-21T01:35:32+08:00 | Bun 1.4.2 | 310,000 | 18.99 ms | 20.07 ms | PASS |
| Deployed Worker | UNEXECUTED | UNEXECUTED | 310,000 | UNEXECUTED | UNEXECUTED | UNEXECUTED |

Remote Worker measurement is deliberately **UNEXECUTED** in Task 15 because remote Cloudflare side effects were not authorized. Before release, run equivalent code on the freshly migrated staging Worker and capture timestamp, runtime compatibility date, p50, and p95.

If either target misses 250 ms, change only `PBKDF2_ITERATIONS`, then rerun authentication tests and both runtime benchmarks before release. Do not claim one target from the other target's result.

## Runtime smoke matrix

| Target | Evidence |
| --- | --- |
| Workers local workerd + local D1 | Run `./scripts/smoke-workers.sh` |
| Workers remote staging + ephemeral D1 | **UNEXECUTED**; run the explicit `--remote` command in the Workers deployment guide |
| Docker/Bun + SQLite | Run `docker build -t oh-my-emby:verify . && ./scripts/smoke-docker.sh` |
| Real SenPlayer | **UNTESTED**; follow `docs/compatibility/senplayer.md` |
