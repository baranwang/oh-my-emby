# Movie Collections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user selects the execution method before implementation.

**Goal:** 让 Rex、Infuse 等 Emby 客户端浏览 TMDB 自动电影合集和上游 BoxSet，并播放当前可访问的成员电影。

**Architecture:** Collections 是独立 Effect 服务，管理合集实体、来源和成员证据。MetadataProviders 负责 TMDB 电影/合集元数据，Collections 使用 Repositories、Identity、UpstreamClient 和 MetadataProviders，但不依赖 Federation。Federation 调用 Collections 并沿用已有电影查询与资源聚合，Emby 负责协议适配；SQLite/D1 使用相同迁移与仓库契约。

**Tech Stack:** TypeScript、Effect 4、Bun、SQLite、Cloudflare Workers/D1、Vitest；不新增产品依赖。

**Spec:** [已确认设计](../specs/2026-10-03-movie-collections-design.md)

## Global Constraints

- 同时支持 TMDB 自动合集与上游 Emby BoxSet；无可靠共同身份的自定义合集独立保留。
- 沿用当前单用户、按需联邦查询和持久缓存架构，同时支持 Bun/SQLite 与 Workers/D1。
- 没有可见成员的合集不显示。合集不计入 MovieCount，不产生可播放的 MediaSources。
- 成员只包含当前启用电影库中可访问的电影；混合库不能查入 series 绑定。
- 保持当前电影 ProviderIds 对客户端的透传策略；内部识别合集不依赖客户端读取电影外部 ID。
- 沿用现有 TMDB credential、语言、缓存、fanout、限时、物化条数上限和429退避规则。
- 不新增后台全库扫描，也不新增创建、编辑、删除合集或批量传播播放状态接口。
- 不变更用户现有媒体库配置来制造测试合集；实际客户端验证明确标记已证实范围。
- 所有提交执行 hooks，使用 conventional commits，附 `Co-authored-by: Codex <noreply@openai.com>`。

## Review Focus

1. 上游成员影片未提供 ParentId 或出现在多个分类：用电影库范围查询证明访问权，不能因属于 BoxSet 就放行（Task 4）。
2. 多语言请求交错、客户端语言变化：稳定合集ID不变化，显示缓存不能串语言，成员关系不能被语言响应覆盖（Task 2）。
3. 上游合集同名但身份不同，或关联后TMDB身份冲突：只合并有可靠共同ID的合集，旧本地ID可解析，冲突关系独立（Tasks 1、4）。
4. 扫描到第二页时429、超时或generation改变：不删除未扫描成员，不标记完整，拒绝过期写入（Tasks 1、4、5）。
5. 客户端省略 IncludeItemTypes、Limit=0、访问空合集旧链接：返回正确类型和数量，零长度页不触发无界扫描，不可见合集返回404（Tasks 5、6）。

## 文件结构与依赖

新增 `core/collection-model.ts` 保存领域类型，`core/collections.ts` 保存按需发现、成员验证和查询，`api/emby-collections.ts` 保存合集 DTO 和入口识别。不把上述逻辑继续堆入 Federation 或 Emby 主文件。

迁移与查询由 `migrations/0006_movie_collections.sql`、`core/repositories.ts`、`platform/bun/sqlite-repositories.ts`、`platform/workers/d1-repositories.ts` 实现。`metadata-providers.ts` 扩展现有provider缓存与TMDB解析；`federation.ts` 只接入合集查询分支与统一分页；`playback.ts` 接入合集图片。

`platform/bun/index.ts` 与 `platform/workers/index.ts` 在 foundation 后构造 Collections，再提供给 Federation 和 Playback。测试layer/harness同步适配新服务，不能给缺少依赖的测试静默返回空合集。

顺序执行 Tasks 1→2→3→4→5→6→7；每个任务先写失败用例、验证失败原因、实现并跑相关测试再提交。

## 共享接口约定

定义于 `core/collection-model.ts`：

- `CollectionScope = { virtualLibraryId: string | null }`；null表示所有启用电影虚拟库。
- `CollectionSource = { serverId: string; catalogNamespace: string; serverGeneration: number; upstreamBoxSetId: string }`。
- `CollectionRecord = { id: string; tmdbCollectionId: string | null; createdAtMs: number; updatedAtMs: number }`。
- `CollectionView = { id: string; displayMetadata: JsonValue; childCount: number; incompleteSourceIds: ReadonlyArray<string> }`。
- `CollectionMovieRef = { canonicalId: string; sourceItemId: string }`。
- `CollectionSnapshot = { source: CollectionSource; collectionId: string; members: ReadonlyArray<CollectionMovieRef>; complete: boolean; observedAtMs: number }`。
- `TmdbCollectionPayload = { id: string; Name: string; Overview?: string; ExternalImages?: ExternalMetadataPayload['ExternalImages']; movieIds: ReadonlyArray<string>; ExternalArtworkRevision?: number; ExternalArtworkLanguage?: string }`；import ExternalMetadataPayload仅使用type，禁止运行时循环依赖。
- `CollectionQuery = { scope: CollectionScope; startIndex: number; limit: number; sort: ReadonlyArray<SortTerm>; searchTerm?: string; clientUserAgent?: string }`；SortTerm使用type import。
- `CollectionPage<A> = { items: ReadonlyArray<A>; totalRecordCount: number; exhausted: boolean; incompleteSourceIds: ReadonlyArray<string> }`。

持久成员证据有唯一来源key和电影source item ID，读操作动态校验generation、健康、quarantine、enabled绑定与canonical alias。合集本身不属于CanonicalItem，以独立ID前缀 `collection:` 区分；全局入口固定 `collections:movies`，旧合集别名由仓库解析。

### Task 1: 持久化合集与来源成员证据

**Files:** 新增 migration、collection-model；修改两平台 repositories、`core/repositories.ts`、`test/repository-contract.ts`、SQLite/D1测试migration加载。

**Interfaces:** Repositories新增以下方法，均返回 `Effect.Effect<结果, RepositoryError>`：

- `upsertCollection(input: { tmdbCollectionId: string | null; source?: CollectionSource; metadata: JsonValue; observedAtMs: number }): CollectionRecord | null`，有source时必须fence；至少有TMDB ID或source。
- `replaceTmdbCollectionMembership(input: { sourceItemId: string; tmdbCollectionId: string | null; expectedGeneration: number; observedAtMs: number }): boolean`，只更新此source item的TMDB证据。
- `writeCollectionSnapshot(input: CollectionSnapshot): boolean`，完整快照替换此source证据，部分快照只upsert。
- `readCollection(id: string, scope: CollectionScope): CollectionRecord | null`、`readCollectionMovies(id: string, scope: CollectionScope): ReadonlyArray<CollectionMovieRef>`、`listVisibleCollections(scope: CollectionScope): ReadonlyArray<CollectionRecord>`、`readCollectionSources(id: string, scope: CollectionScope): ReadonlyArray<CollectionSource>`。
- `readCollectionRevision(): number`，所有有效关系写入、身份合并会增加revision；查询key另包含当前库配置/generation与TMDB设置revision。

- [ ] **Step 1:** 在shared repository contract添加用例，使用电影source fixtures构造同TMDB合集的两个来源，断言合并为一个record且两个成员；同名无TMDB ID断言两个record。添加部分快照、旧generation写入、alias、禁用/隔离、独立证据更新用例。
      代表断言（fixtures复用shared contract的电影source）：

```ts
expect(first.id).toBe(second.id); // 两来源均为 TMDB collection 20
expect(customA.id).not.toBe(customB.id); // 同名，无外部身份
expect(await readMovieIds(first.id)).toEqual([movie10.id, movie11.id]);
expect(staleGenerationWrite).toBe(false);
```

- [ ] **Step 2:** 运行 `bun --bun apps/server/node_modules/vitest/vitest.mjs run --root apps/server test/sqlite-repository.test.ts`，确认失败由缺少合集方法导致。
- [ ] **Step 3:** 实现四类表：实体、上游来源、成员证据、合集别名；为TMDB ID和来源身份建立唯一索引。使用现有SQL事务惯例实现上述接口，多个movie refs解析后按canonical ID去重。查询仅选择movies binding；禁用过滤实时执行。
- [ ] **Step 4:** 重跑SQLite测试，再运行 `bun run --cwd apps/server test:workers`，确认shared contract两平台一致，所有已有迁移与仓库测试通过。
- [ ] **Step 5:** 提交 `feat(collections): persist scoped collections and membership evidence`。

### Task 2: 读取TMDB电影合集与本地化合集元数据

**Files:** 修改 `core/metadata-providers.ts`、`test/metadata-providers.test.ts`；复用Task 1仓库方法。

**Interfaces:**

- ExternalMetadataPayload新增 `TmdbMovieId?: string` 和 `TmdbCollectionId?: string | null`，null表示成功确认无合集，undefined表示未确认。
- MetadataProviders新增 `readTmdbCollection(id: string): Effect.Effect<TmdbCollectionPayload | null, RepositoryError>`；它受ClientLanguage上下文控制，沿用现有配置、缓存与容错，错误不抛到电影详情。
- 电影refresh在确认movie详情后调用 `replaceTmdbCollectionMembership`；没有TMDB元数据成功结果时不写null。

- [ ] **Step 1:** 添加tests：movie ID=10且IMDb同时存在仅以movie ID读详情；IMDb find得到10后补读 `/movie/10`；`belongs_to_collection.id=20`写关联20；成功null移除TMDB证据而保留BoxSet证据；429不删除旧关联。
      代表断言：

```ts
expect(paths).toContain("/movie/10");
expect(paths).not.toContain("/find/tt10"); // movie ID 已知的场景
expect(membership.tmdbCollectionId).toBe("20");
expect(english.id).toBe(chinese.id);
expect(english.Name).not.toBe(chinese.Name);
```

- [ ] **Step 2:** 运行 `bun --bun apps/server/node_modules/vitest/vitest.mjs run --root apps/server test/metadata-providers.test.ts`，确认新增断言失败。
- [ ] **Step 3:** 解析并缓存movie详情的合集关系；先以 `upsertCollection` 写入确认过的TMDB合集身份，再替换该电影source item的TMDB成员证据。合集缓存identity namespace采用`tmdb:collection`并沿用client-language cache identity。实现 `/collection/20` 的名称/简介/图片/parts解析，过滤非法或非正整数ID，同请求去重；当前设置禁用时返回null且不联网。
- [ ] **Step 4:** 添加交错zh-CN/en-US缓存、固定语言覆盖、设置更新失效、成功空结果negative cache、response大小上限、重复parts ID用例；跑metadata与tmdb-artwork测试全部通过。
- [ ] **Step 5:** 提交 `feat(tmdb): cache movie collection metadata and associations`。

### Task 3: TMDB合集领域查询与成员补齐

**Files:** 新增 `core/collections.ts`、`test/collections.test.ts`；使用Task 1/2接口。

**Interfaces:** `Collections` Effect Service，`makeCollectionsLayer()` 依赖Repositories、Identity、UpstreamClient、MetadataProviders，产生：

- `list(query: CollectionQuery): Effect.Effect<CollectionPage<CollectionView>, CollectionFailure>`。
- `detail(id: string, scope: CollectionScope, clientUserAgent?: string): Effect.Effect<CollectionView | null, CollectionFailure>`。
- `members(id: string, query: CollectionQuery): Effect.Effect<CollectionPage<string> | null, CollectionFailure>`，items为规范电影ID。
- `image(id: string, scope: CollectionScope, imageType: string, clientUserAgent?: string): Effect.Effect<{ url: URL; source: CollectionSource | null } | null, CollectionFailure>`；source=null表示TMDB图片。
- `CollectionFailure` 明确为RepositoryError、IdentityFailure、UpstreamFailure的联合；单来源故障转为内部incompleteSourceIds，仓库错误仍失败。

- [ ] **Step 1:** 编写带2启用电影库与1series库的tests：读取TMDB合集20、parts10/11/12，只有10和11上游可访问，断言2个本地成员；跨上游同电影10输出一次，保留其media versions；series库不被请求。
      代表断言：

```ts
expect(page.items).toEqual([movie10.id, movie11.id]);
expect(page.totalRecordCount).toBe(2); // TMDB parts 有三部，可访问两部
expect(requestedLibraryTypes).not.toContain("series");
expect(await collections.detail(emptyId, scope)).toBeNull();
```

- [ ] **Step 2:** 运行 `bun --bun apps/server/node_modules/vitest/vitest.mjs run --root apps/server test/collections.test.ts`，确认失败。
- [ ] **Step 3:** 实现稳定collection身份、TMDB元数据读取和movie精确发现；调用Identity.resolve使用真实电影sourceLibraryId与generation，不向身份库写TMDB parts占位电影。只对启用movies scope补齐，复用现有请求预算常量，按配置UA访问上游。
- [ ] **Step 4:** 验证空缓存不扫描电影库、已发现合集按parts补齐、TMDB禁用隐藏纯自动合集、无可见成员返回null、上游同电影多版本保留。运行collections及identity测试。
- [ ] **Step 5:** 提交 `feat(collections): discover accessible TMDB collection movies`。

### Task 4: 上游BoxSet发现、成员验证与身份合并

**Files:** 修改 `core/collections.ts`；扩展 `test/collections.test.ts`、必要的 `test/upstream-client.test.ts`。

**Interfaces:** 使用Task 3既有service接口；上游 discovery从list触发，members按BoxSet source逐个同步成员。不要把BoxSet加入SourceItemCandidate的可播放类型。

- [ ] **Step 1:** mock `/Users/{upstreamUser}/Views` 包含boxsets入口；分页Items返回BoxSet；成员查询返回有/无ParentId及跨电影库影片。断言只有已证实在启用movies scope中的movie canonical IDs输出；BoxSet入口不是电影binding。
      代表断言：

```ts
expect(visibleIds).not.toContain(disabledLibraryMovie.id);
expect(afterPartialRefresh.items).toContain(previouslyConfirmedMovie.id);
expect(afterPartialRefresh.exhausted).toBe(false);
expect(await collections.detail(oldAlias, scope)).toMatchObject({ id: tmdbCollection.id });
```

- [ ] **Step 2:** 运行collections测试确认失败。
- [ ] **Step 3:** 实现Views或server范围BoxSet发现、详情与图片元数据、来源身份和可信TMDB collection ProviderIds映射。对成员使用movie library范围精确查询证实membership，完整扫描才replace快照。429/超时保留旧成员并标记不完整，generation变化拒绝写入。
- [ ] **Step 4:** 添加同名独立自定义合集、两BoxSet同TMDB ID与自动合集合并、晚到TMDB关联保留旧ID、冲突身份不合并、第二页失败不删除、少量上游不支持BoxSet返回404不影响其他来源的断言。运行collections/upstream/repository相关tests。
- [ ] **Step 5:** 提交 `feat(collections): federate upstream BoxSet membership safely`。

### Task 5: 联邦查询中的BoxSet、成员与统一分页

**Files:** 修改 `core/federation.ts`、`test/federation.test.ts`、`test/pagination.test.ts`、两平台index与需要新service的test layers。

**Interfaces:** FederatedQuery新增可选 `collectionId?: string`；保持`virtualLibraryId`仅指实际电影库scope。CanonicalItemView新增可选`collection?: { childCount: number }`；BoxSet view的mediaVersions为空。Federation新增 `collectionsAvailable(): Effect.Effect<boolean, FederationFailure>` 供Views入口判断；FederationFailure包含CollectionFailure已有成员。

- [ ] **Step 1:** 添加BoxSet单独查询、Movie/BoxSet混合升降序分页、collectionId成员默认Movie、同影片多版本、空合集detail=null、Limit=0及更新配置后旧分页不可见成员用例。
      代表断言：

```ts
expect([...page1.items, ...page2.items].map((x) => x.id)).toEqual(expectedSortedIds);
expect(new Set([...page1.items, ...page2.items].map((x) => x.id)).size).toBe(4);
expect(zeroLimit.items).toEqual([]);
expect(movieCounts.MovieCount).toBe(2); // 两部电影另有两个合集
```

- [ ] **Step 2:** 跑federation/pagination测试确认新断言失败。
- [ ] **Step 3:** 在list中分别发现普通电影与合集后，合并到同一个query generation进行排序/去重/分页。collection成员ID通过现有电影detail/view流程输出；不要每个page独立重新排序，也不要改变Series/Season路径。快照key加入collection revision与有效movie scope状态、TMDB设置revision；执行时重新过滤失效scope。
- [ ] **Step 4:** 两平台按foundation→Collections→Federation顺序组装；更新测试层，补跨平台schema/迁移及混合库回归。跑federation、pagination、cross-platform和ten-source-budget测试，确认BoxSet不计入MovieCount。
- [ ] **Step 5:** 提交 `feat(federation): paginate movie collections and members`。

### Task 6: Emby合集入口、DTO与图片兼容

**Files:** 新增 `api/emby-collections.ts`；修改 `api/emby.ts`、`core/playback.ts`、`test/emby-catalog.test.ts`、`test/playback.test.ts`、`test/resources.test.ts`、两平台routing tests。

**Interfaces:** `collectionDto(view: CollectionView, serverId: string): EmbyItemDtoValue`，`isCollectionsRoot(id: string): boolean`；根ID为`collections:movies`。API解析ParentId为根或collection ID时构造正确的scope/collectionId，而不将其误传virtualLibraryId。图片通过Collections.image获取TMDB或上游source，复用现有注册资源和Infuse图片策略。

- [ ] **Step 1:** Emby测试断言Views含boxsets入口、只在可见集合非空时显示，详情Type=BoxSet/IsFolder=true/ChildCount=2且无MediaSources，成员请求返回电影，旧alias可读。无IncludeItemTypes时默认Movie，空合集/停用后旧链接404。
      代表断言：

```ts
expect(dto).toMatchObject({ Type: "BoxSet", IsFolder: true, ChildCount: 2 });
expect(dto.MediaSources ?? []).toEqual([]);
expect(memberPage.Items.map((x) => x.Type)).toEqual(["Movie", "Movie"]);
expect(collectionPlayback.status).toBe(404);
expect(infuseImage.status).toBe(200);
```

- [ ] **Step 2:** 跑emby-catalog/playback tests确认失败。
- [ ] **Step 3:** 实现入口和DTO适配，成员查询沿用已有排序/搜索/用户状态过滤与数量口径；保留电影ProviderIds策略。BoxSet收藏/播放写操作明确拒绝，不通过电影outbox传播；电影操作不变。
- [ ] **Step 4:** 在Playback.resolveImage中处理合集并复用允许的图片来源验证、ResourceCache、Infuse代理GET/HEAD；停用scope先返回not found。测试TMDB图片、上游图片fallback、Infuse200代理及普通客户端302；合集PlaybackInfo与stream返回not found。
- [ ] **Step 5:** 跑Emby、playback、resources和Workers routing tests，确认电影与剧集原接口不回归，提交 `feat(emby): expose BoxSet browsing and collection artwork`。

### Task 7: 完整验证、实际客户端与交付

**Files:** 更新 `docs/compatibility/runtime.md`，必要时新增 `docs/compatibility/collections.md`；不改用户配置。

**Interfaces:** 无新产品接口；记录证据并完成计划checkbox。

- [ ] **Step 1:** 串行运行 `bun run test`、`bun run --cwd apps/server test:workers`、`bun run typecheck`、`bun run build`；每个exit=0后再开始下一个，记录passed/skipped数量。
- [ ] **Step 2:** 使用当前登录/临时会话只读验证真实TMDB合集和上游BoxSet：记录入口、合并、成员数量、member电影PlaybackInfo和流GET/HEAD。日志隐藏token、password、签名URL；临时会话验证后删除。
- [ ] **Step 3:** 在可用Rex/Infuse中实测合集列表、图片、成员与电影播放；没有本机客户端或上游无BoxSet时明确未实测部分，提供接口证据，不宣称客户端成功。
- [ ] **Step 4:** 按用户选择的执行方式完成review：原生执行在末尾进行一次独立review；逐任务子代理执行按相应skill review gates。修复发现的问题后只重跑受影响检查，再`git diff --check`。
- [ ] **Step 5:** 提交验证说明、检查git状态和分支，按已授权推送；最终中文说明实际功能、按需发现边界、验证范围和commit。

## 自审与交接

覆盖检查：Task 1承担generation/alias/访问过滤；Task 2承担TMDB与语言；Tasks 3/4承担两种发现和失败快照；Task 5承担分页和数量；Task 6承担客户端入口、成员、图片与不可播放限制；Task 7承担双平台和实测。

依赖检查：Collections不调用Federation；MetadataProviders只写仓库成员证据，不调用Collections。电影域继续保存自己的canonical/movie versions，BoxSet只在协议查询层被适配为集合视图。

执行前需用户审阅本计划并选择执行方式；本计划尚未执行，任何勾选都只能在对应证据确认后更新。
