# SenPlayer compatibility evidence

No real SenPlayer session was available or authorized for Task 15. Every client-specific item below is therefore **UNTESTED**. Automated protocol and runtime tests are not presented as real-client evidence.

## Capture identity

| Evidence | Status | Required capture |
| --- | --- | --- |
| Platform and OS build | UNTESTED | Exact device platform, OS version/build, and architecture |
| SenPlayer build | UNTESTED | Exact app version/build and distribution channel |
| Test timestamp | UNTESTED | ISO-8601 timestamp with timezone |
| Sanitized request sequence | UNTESTED | Ordered method/path/status log with tokens, cookies, hostnames, IDs, and media titles redacted consistently |

## Discovery and catalog

| Behavior | Status | Required action and evidence |
| --- | --- | --- |
| Root and `/emby` aliases | UNTESTED | Capture which aliases SenPlayer actually requests and each response status |
| First-page catalog | UNTESTED | Open a virtual library and capture requested fields, item types, start index, limit, returned count, and total |
| Count increase/decrease | UNTESTED | Refresh while upstream totals change; capture old/new totals and visible client behavior |
| Terminal empty page | UNTESTED | Page beyond exhaustion and capture the final empty `Items` response and stable terminal count |
| Required fields | UNTESTED | Record any missing-field client failure and the smallest field set that renders correctly |

## Playback

| Behavior | Status | Required action and evidence |
| --- | --- | --- |
| Version selection | UNTESTED | Select two different upstream versions and capture the local stable `MediaSourceId` chosen each time |
| PlaybackInfo | UNTESTED | Capture sanitized request/response showing local paths and no upstream URL/token leakage |
| Real stream request and 302 | UNTESTED | Start playback and capture the actual stream request, `302`, private/no-store headers, empty body, and upstream redirect target with token redacted |
| Seeking | UNTESTED | Seek backward and forward; capture progress requests, resulting position, and any playback restart |
| Audio selection | UNTESTED | Switch audio tracks and capture requested stream index plus observed output |
| Subtitle selection | UNTESTED | Switch embedded/external text subtitles and capture route, format, stream index, and observed rendering |

## State convergence

| Behavior | Status | Required action and evidence |
| --- | --- | --- |
| Watched state | UNTESTED | Mark played/unplayed and capture local response, upstream outbox outcome, and refreshed client state |
| Resume state | UNTESTED | Stop mid-item, reopen, and capture saved ticks plus resumed position |
| Near-end completion | UNTESTED | Stop near the end and capture whether SenPlayer separately marks the item played; current server behavior marks stop complete only at `PositionTicks >= RunTimeTicks` |

## Failures

Explicit observed failures: **UNTESTED**. During capture, record every non-2xx response, timeout, missing control, wrong count, failed seek/track change, playback fallback, and state mismatch with the sanitized request sequence. Do not turn an unobserved item into a pass.
