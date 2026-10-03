# Movie collections compatibility

TMDB automatic movie collections and upstream Emby BoxSets share a local BoxSet interface. Proven matching TMDB collection IDs merge; custom sets without that identity remain separate. Existing local aliases continue to resolve. Members must be actual movies in currently enabled movie library bindings. A collection never grants access to an otherwise unavailable movie.

## Discovery and limits

Discovery remains demand driven. Movie metadata refresh associates its TMDB collection; opening a known collection checks TMDB parts against eligible movie sources. BoxSet discovery queries upstream collection listings and falls back to user Views when needed. It does not scan the entire movie catalog to invent collections.

Successful discovery progress is reused for fifteen minutes, scoped by source generation, bindings, parts and client UA. Interrupted requests continue from saved in-process progress; a process restart may repeat discovery. Already verified member evidence is persisted incrementally. Partial or failed scans preserve previous evidence, while completed source snapshots replace it. Disabled bindings and changed generations are filtered immediately.

The existing 2,000-item materialization ceiling applies to combined movie/BoxSet queries. Requests exceeding the combined ceiling can return a limit error; browsing the collection root and its members avoids a whole movie catalog mixed query. `Limit=0` reads known cached membership without network discovery; an incomplete result does not claim an exact remote catalog total.

Query snapshots isolate client language, source participation, metadata settings, local revisions, users and devices. Complete snapshots cannot be downgraded by late partial writes. State-dependent results are recomputed. Persistent query snapshots expire and retain at most 500 keys; discovery caches are similarly bounded, and provider locks are released when callers finish.

## Protocol behavior

- `/Users/{user}/Views` includes `collections:movies` only when accessible collections exist.
- `ParentId=collections:movies` defaults to BoxSet; a local collection ParentId defaults to Movie.
- BoxSet DTOs contain local image tags, child counts and an empty `MediaSources` array. Movie ProviderIds follow the existing project policy.
- Collection images use validated TMDB artwork or registered upstream image endpoints. Infuse image GET/HEAD returns proxied image content; other clients use redirects.
- Collections cannot be played or receive movie state writes. Empty or inaccessible collection detail links return 404.

## Evidence — 2026-10-03

The real local Bun service exposed three upstream BoxSets merged with matching TMDB identities. The 007 collection resolved 26 accessible movies. API probes confirmed collection Views/list/member responses, JPEG image GET/HEAD 200, member PlaybackInfo 200, video GET/HEAD redirects and a direct byte-range response 206. Collection PlaybackInfo returned 404. Temporary diagnostic sessions were removed; credentials and signed locations were not recorded.

Infuse 8.5.6 visibly displayed the collection root, all three collections, 007 members and posters. “Live and Let Die” entered playback on retry and playback was closed after verification. Its initial attempt returned 401 and did not reproduce on retry; another direct probe encountered an upstream 429. These transient upstream failures are not treated as proven authentication fixes.

Rex could not be launched in this session. Its browsing and redirect behavior is covered by automated protocol tests; no real Rex UI success is claimed. Workers/D1 evidence is local workerd testing, not remote deployment.

During development the local watcher had applied migration 0006 before its final tombstone table definition was written. The missing `collection_membership_updates` table was added locally with `CREATE TABLE IF NOT EXISTS`, matching the committed migration, without deleting data or changing library configuration. Clean SQLite and D1 migrations pass independently.

## Execution rulings and costs

- Reused the existing clean feature checkout for the authorized live workflow; moving the work would require another checkout if isolation later proves necessary.
- Shared collection SQL behind SQLite transaction/D1 batch adapters; a platform-specific divergence would require an adapter fix.
- Added per-movie membership tombstones so late responses cannot re-add removed TMDB relations; this costs one small table. Collection records also carry fallback display metadata.
- Added an optional TMDB evidence filter to collection scope so disabled providers do not leak automatic members inside merged sets; this adds a scope adapter field. BoxSet-only discovery is permitted before any movie catalog scan.
- Used separate JSON query snapshots because the existing canonical-item foreign key cannot hold collection IDs; this costs a separate query cache table.
- List display reads cached TMDB metadata, warmed when a movie acquires a collection; a new association costs one initial collection metadata lookup while collection detail may refresh it.
- Retained the existing combined 2,000-item materialization ceiling; very large mixed movie/BoxSet queries may return an explicit limit error.
- Did not classify the nonreproducing initial 401 as a new authentication defect; intermittent upstream/client failures may still need separate reproducible diagnosis.

The independent reviewer’s seven confirmed Important findings were fixed in one pass with failing-then-passing regression tests. No deferred Minor findings remain. State-dependent mixed snapshots and cold zero-length cached counts were additionally verified and corrected. Real client assertions remain limited to the observed Infuse result; Rex and remote Workers were not claimed.
