# Runtime compatibility evidence

Release gates distinguish local automation from remote runtime evidence. A successful build is not a runtime measurement.

## PBKDF2-SHA-256

The authentication cost is defined once by `PBKDF2_ITERATIONS` in `apps/server/src/core/limits.ts`. Each benchmark performs ten real derivations, discards the first, reports p50/p95, rejects zero/non-finite samples, and exits nonzero when p95 is 250 ms or higher.

```sh
bun scripts/benchmark-pbkdf2.ts
```

| Target          | Measurement                | Timestamp                 | Runtime            | Iterations |        p50 |        p95 | Gate       |
| --------------- | -------------------------- | ------------------------- | ------------------ | ---------: | ---------: | ---------: | ---------- |
| Local Bun       | in-process                 | 2026-09-21T02:05:47+08:00 | Bun 1.4.2          |    310,000 |   17.84 ms |   18.96 ms | PASS       |
| Deployed Worker | remote request upper bound | UNEXECUTED                | Cloudflare Workers |    310,000 | UNEXECUTED | UNEXECUTED | UNEXECUTED |

Remote Worker measurement is deliberately **UNEXECUTED** in Task 15 because remote Cloudflare side effects were not authorized. Deployed Workers deliberately freeze high-resolution timers while CPU-only code runs, so the temporary Worker performs one untimed derivation per authenticated request and `scripts/benchmark-workers-pbkdf2.ts` measures ten requests from the caller. The recorded value is therefore a conservative end-to-end upper bound that includes network latency, not a fabricated CPU-only duration. `./scripts/smoke-workers.sh --remote` runs this benchmark after the application smoke and prints the result before deleting the run-owned resources.

Workers use 100,000 PBKDF2 iterations because 310,000 iterations exceeds the Worker CPU budget during interactive setup. If either target misses 250 ms, change only `PBKDF2_ITERATIONS`, then rerun authentication tests and both runtime benchmarks before release. Do not claim one target from the other target's result.

## Runtime smoke matrix

| Target                                | Evidence                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workers local workerd + local D1      | Run `./scripts/smoke-workers.sh`                                                                                                                                         |
| Workers remote staging + ephemeral D1 | **UNEXECUTED**; the local fake-API integration proves fail-closed Worker ownership and exact-ID cleanup, but run the explicit `--remote` command for Cloudflare evidence |
| Docker/Bun + SQLite                   | Run `docker build -t oh-my-emby:verify . && ./scripts/smoke-docker.sh`                                                                                                   |
| Real SenPlayer                        | **UNTESTED**; follow `docs/compatibility/senplayer.md`                                                                                                                   |

## Movie collections

See [collections compatibility evidence](collections.md) for TMDB/upstream BoxSet discovery, access filtering, Infuse verification, and the unverified real Rex/remote Workers portions.

## Library covers (2026-10-03)

- Real in-app Chromium browser, standalone Bun test instance on localhost:3002: Dashboard login → libraries automatic generation → nine registered-source PNG posters → Satori SVG → Canvas system-font JPEG → authenticated upload → SQLite → visible list/detail cover. Manual regeneration also verified. Persisted JPEG was 84,249 bytes; authenticated Emby HTTP returned the identical SHA-256 revision before and after a Bun process restart and removal of the disposable resource cache. Fixture posters use gradients rather than copyrighted artwork.
- Chinese titles and a long Chinese/emoji title rendered in the real browser; image output visually checked for rotation, clipping and text boundaries.
- Authenticated Emby HTTP protocol tests cover Views/details/VirtualFolders tags, Primary index 0, GET/HEAD/304, old-tag revalidation, missing/disabled libraries and ordinary movie routing. Real Emby clients remain **UNTESTED**.
- Local workerd/D1 tests and smoke validate local runtime compatibility. Remote deployed Workers remain **UNEXECUTED**. Rendering modules and Yoga are Dashboard static assets, not Worker executable dependencies.

Final whole-branch review found D1 catalog/summary parameter limits, malformed JPEG frame headers and asset-stage 401 handling. Each issue had a failing regression test before its fix. Production Effect D1 adapter BLOB round trips, 200-item candidate selection, 201 summary IDs, config invalidation/deletion, StrictMode generation lifecycle, upload-conflict recovery, partial/zero poster failures and URL cleanup are covered.

Execution decisions: preserve original checkout changes in an isolated worktree; use the existing authenticated upstream image pipeline with same-origin redirect restrictions (redirect-only sources can lack posters); initialize the browser-only Yoga asset explicitly; pin Satori 0.26.0 because 0.35's additional HarfBuzz loading failed under Vite (upgrades require browser regression checks). No remote deployment or real-client verification was inferred from local evidence; browser visits remain required and system-font appearance can vary.

Deferred minor: navigation abort releases browser work, but an already running server-side upstream image request may continue to its deadline. Propagating its request signal through the server Effect is future work.

Reference-layout correction (`rotated-title-v3`): the user clarified with an attached reference image that posters stay on the right and only the library name is centered within the left text area. The full-bleed `centered-posters-v2` interpretation was withdrawn. Real-browser preview verified the restored tilted poster layout, centered Chinese name and absence of a subtitle; the sample JPEG was 234,287 bytes. The template-version regression test still confirms older covers are marked stale without losing the saved revision before replacement.

Background extraction (`rotated-title-v4`) was checked against the referenced Python `cover_style.py`: sample the first poster after `315426987` ordering; resize to 100×100; saturation-weighted circular hue average with the 0.05 threshold; HLS→RGB at L=S=0.32 with integer truncation; gray-only images use hue 0. Tests compare four multi-color fixtures with independently computed Python `colorsys` results and distinguish the third source poster from the first. Browser high-quality resizing approximates Pillow LANCZOS rather than claiming identical interpolation.
