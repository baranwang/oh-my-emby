# 媒体库入口封面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 浏览器生成参考模板风格的媒体库入口封面，持久化至 SQLite/D1，并供 Dashboard 与 Emby 客户端使用。

**Architecture:** Satori 只生成背景和海报布局，Canvas 使用系统字体绘制标题并编码 JPEG。后端管理受限海报清单、上传版本校验、持久化与图片读取，沿用 Effect 服务和双平台适配。前端串行补齐缺失或配置过期封面，生成失败保留旧图。

**Tech Stack:** TypeScript、Effect 4、React 19、TanStack Query、Satori、Canvas、Bun SQLite、Cloudflare Workers/D1、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-03-library-covers-design.md`

## Global Constraints

- 图形模板以 320 × 180 为基准，输出 1920 × 1080 JPEG；上传上限 500 KiB，即 512000 bytes。
- JPEG 质量从约 0.85 降至 0.5，仍超限则失败，不提交超限图片。
- 三列三行、错位海报、参考视觉倾斜方向、九宫格顺序 `315426987`；不足九张循环补齐。
- 主标题取库名，副标题默认 `Movies` / `TV Series`；全部文字使用系统字体，不下载封面字体。
- 生成清单有效期十分钟，每库最多四份；每来源最多一页二十条，总计最多两百条，候选上限十八张，成功选图上限九张。
- 只为当前有效的启用来源选图；Movie/Series 按规范 ID 去重，不能选 Episode 或其他媒体库条目。
- 服务端不执行像素合成或完整 JPEG 解码，不增加渲染 WASM、Sharp、R2 或外部生成服务。
- 自动生成限管理员访问媒体库页面，每次访问每库只尝试一次；新增影片不自动使封面过期。
- 所有素材接口同源返回字节，不将重定向到外站的图片用于 Canvas；保留既有鉴权与 Origin 校验。
- 提交只包含相关文件，提交信息添加 `Co-authored-by: Codex <noreply@openai.com>`。

## Review Focus

- 两个标签页同时生成，或请求重试：旧上传不能覆盖已保存的新封面；任务 1、2 测试条件写入与凭据消费。
- 字体回退、Emoji、混合中英文长名称：标题测量与绘制保持一致，不能下载字体或覆盖右侧海报；任务 4 浏览器验收。
- 单张恶意超大像素海报：压缩文件也可能解码占用大量内存；任务 3 验证字节上限，任务 4 限制可识别图片尺寸并验证失败回退。
- 生成过程中来源被停用、库删除或凭据过期：素材和上传立即失效，不能复活已删除图片；任务 2、3 验证。
- Cookie 不覆盖 Emby 路径、旧 image tag、HEAD/304：Dashboard 使用正确同源路径，客户端能重新获取新图且不绕过权限；任务 3、6 验证。

## 文件职责

- `packages/contracts/src/library-covers.ts`：Dashboard 封面摘要和生成清单 schema；在 `schemas.ts`、`dashboard.ts`、`index.ts` 接入。
- `apps/server/src/core/library-cover-model.ts`：内部记录、仓储接口、约束和 tagged errors。
- `apps/server/src/core/library-cover-repositories.ts`：共享 SQL 封面与清单操作；平台适配只提供 SQL 和事务。
- `apps/server/src/core/library-cover-candidates.ts`：缓存优先、来源预算和规范条目去重。
- `apps/server/src/core/library-covers.ts`：清单生命周期、版本校验、上传与素材服务。
- `apps/server/src/core/library-cover-jpeg.ts`：不解码像素的有界 JPEG 帧头校验。
- `apps/server/src/api/dashboard-library-covers.ts`：Dashboard 二进制素材、上传和封面 HTTP 行为；主 dashboard 模块负责接线。
- `apps/server/src/api/emby-library-covers.ts`：虚拟库 DTO 图片字段和图片读取的薄适配，避免继续扩大 `emby.ts`。
- `apps/dashboard/src/modules/libraries/covers/{template.tsx,render.ts,assets.ts,coordinator.ts}`：图形模板、Canvas 文字/编码、下载预处理、串行任务。
- `apps/dashboard/src/modules/libraries/services/library-cover-service.ts`、`hooks/use-library-covers.ts`、`components/library-cover.tsx`：HTTP 调用、查询状态接入、预览与刷新。

任务按 1→2→3→4→5→6 顺序执行，不并行修改共享接口。

### Task 1: 持久化、契约和上传帧头校验

**Files:** 新建 `apps/server/migrations/0008_library_covers.sql`、上述 contracts/model/repositories/jpeg 文件、`apps/server/test/library-cover-repository-contract.ts`、`apps/server/test/library-cover-jpeg.test.ts`；修改 `packages/contracts/src/{schemas.ts,index.ts}`、`apps/server/src/core/repositories.ts`、`apps/server/src/platform/{bun/sqlite-repositories.ts,workers/d1-repositories.ts}`、`apps/server/test/{sqlite-repository.test.ts,d1-repository.test.ts}`。

**Interfaces:**
- `LibraryCoverSummary = { revision: string; width: 1920; height: 1080; stale: boolean }`；`VirtualLibraryView.cover` 为可选摘要。
- `LibraryCoverRecord` 包含 `libraryId, body: Uint8Array, revision, templateVersion, configDigest, width, height, updatedAtMs`；`LibraryCoverManifest` 包含 `token, libraryId, configDigest, serverFences, candidates, expectedRevision: string | null, expiresAtMs`。
- `CoverCandidate = { canonicalId: string; serverId: string; sourceLibraryId: string; serverGeneration: number; upstreamItemId: string; imageTag: string | null }`。
- `LibraryCoverRepositories` 提供 `getLibraryCover(id)`、`listLibraryCoverSummaries(ids)`、`saveLibraryCoverManifest(manifest)`、`getLibraryCoverManifest(token)` 和 `commitLibraryCover({ token, cover, nowMs }): Effect<boolean, RepositoryError>`。`commitLibraryCover` 在同一事务/原子 SQL 条件写入中校验 manifest、旧 revision、库配置与来源 fence，成功消费 token。
- `validateLibraryCoverJpeg(bytes: Uint8Array): { width: 1920; height: 1080 }`，无效、超限或非预期尺寸抛出 `LibraryCoverValidationFailed`。

- [ ] 写失败测试：保存后读取字节完全相等；重开 SQLite 后仍存在；两份相同旧 revision 的清单仅第一次提交成功；token 十分钟边界失效；每库第五份清单淘汰最旧；删除库清理图片和清单；摘要查询不加载 BLOB。
- [ ] 写 JPEG 失败测试：512001 bytes 拒绝；错误 MIME 之外仍校验签名；截断 segment、非法长度、无 SOF、非 1920×1080 拒绝；合法基线和渐进 JPEG 通过。
- [ ] 在 `apps/server` 运行 `bun --bun vitest run test/sqlite-repository.test.ts test/library-cover-jpeg.test.ts`，确认新行为失败后实现上述接口。迁移使用参数绑定 BLOB，配置摘要基于固定顺序规范化的库名、类型与来源绑定；新增事务 SQL 必须同时适配 Bun 和 D1。
- [ ] 运行同一命令及 `bun --filter @oh-my-emby/server test:workers`，均 PASS；提交 `feat: persist versioned library covers`。

### Task 2: 受限选图与封面业务服务

**Files:** 新建上述 candidates/service 文件和 `apps/server/test/library-covers.test.ts`；修改 `apps/server/src/core/library-service.ts`、`apps/server/src/core/errors.ts` 及必要的目录仓储查询。

**Interfaces:**
- `selectLibraryCoverCandidates(library: VirtualLibrary): Effect<ReadonlyArray<CoverCandidate>, RepositoryError | UpstreamFailure>`；输入内部库记录，缓存优先，只对仍缺素材的有效来源做限定目录请求。
- `LibraryCoverPreparation = { token: string; title: string; subtitle: string; templateVersion: string; expiresAtMs: number; candidates: ReadonlyArray<{ index: number; url: string }> }`，候选内部上游位置不进入契约。
- `LibraryCoverService.prepare(id)` 返回 preparation；`read(id)` 返回 record 或 null；`upload({ libraryId, token, bytes })` 返回 summary；`asset({ libraryId, token, index, signal })` 返回有界图片字节及 MIME。所有方法使用 Effect，错误采用明确的 RepositoryError、NotFound、Conflict、ValidationFailed 和 UpstreamFailure 映射。
- 列表/详情查询批量或单次读取摘要，通过当前配置摘要决定 `stale`，避免每库一次 BLOB 查询。

- [ ] 写失败测试：规范 ID 去重、稳定顺序、series 不选 Episode、缓存够用则零目录请求；十来源各一页二十条且候选最多十八张；部分来源失败可用已证实素材，零素材不发生成清单。
- [ ] 写生命周期失败测试：配置修改、来源 generation 改变、停用来源、删除库、过期 token 使素材和上传失败；token 属于其他库或 index 越界拒绝；冲突不覆盖旧图片。
- [ ] 在 `apps/server` 运行 `bun --bun vitest run test/library-covers.test.ts test/library-service.test.ts`，确认失败，再实现接口。素材下载复用 registered upstream resource 路径，不接受客户端 URL；不为了保证九张素材扩大目录预算。
- [ ] 运行上述测试至 PASS；提交 `feat: prepare bounded library cover assets`。

### Task 3: Dashboard 图片 API 与双平台接线

**Files:** 新建 `apps/server/src/api/dashboard-library-covers.ts`、`apps/server/test/dashboard-library-covers.test.ts`；修改 `packages/contracts/src/dashboard.ts`、`apps/server/src/api/dashboard.ts`、`apps/server/src/platform/{bun/index.ts,workers/index.ts}`、两平台 routing 测试。

**Interfaces:** POST prepare 返回任务 2 的 preparation；GET 素材返回字节；PUT cover 用原始 JPEG body 和 `X-Cover-Token` header 返回 summary；GET/HEAD cover 返回 record 的字节/元信息。挂载路径完全采用 spec 的 `/api/dashboard/libraries/:id/cover` 系列接口。

- [ ] 写失败测试：未登录 401；跨源 POST/PUT 按现有 Origin 规则拒绝；不同库 token 不能读素材；流式读入在 500 KiB 边界终止；GET 素材为 200 字节而非外站 302；异常上游、超限 body 及中断有明确错误且保留旧图。
- [ ] 写 GET/HEAD/ETag 测试：会话 cookie 路径可覆盖图片 URL，HEAD 没有 body，匹配 ETag 返回 304，不匹配返回当前 JPEG；图片响应使用私有缓存策略，缓存命中前仍做鉴权。
- [ ] 在 `apps/server` 运行 `bun --bun vitest run test/dashboard-library-covers.test.ts test/bun-routing.test.ts` 确认失败，再实现。contracts 的 JSON prepare 用现有 HttpApi；原始 body/Response 采用项目已使用的 Effect HTTP request/response 支持，集中放入薄适配模块。
- [ ] Bun 测试、Workers routing 和 `bun --filter @oh-my-emby/server test:workers` PASS；确认服务层依赖方向不形成 LibraryService/Federation/Covers 循环；提交 `feat: expose authenticated library cover endpoints`。

### Task 4: Satori 图形模板与系统字体 Canvas 渲染

**Files:** 新建前端 `covers/{template.tsx,render.ts,assets.ts}`、`apps/dashboard/test/library-cover-render.test.ts`；修改 `apps/dashboard/package.json` 和 `bun.lock`，只在 dashboard 添加 Satori 依赖。

**Interfaces:**
- `CoverRenderInput = { title: string; subtitle: string; posters: ReadonlyArray<string>; background: string }`，posters 是已缩小的图片 data URL。
- `createLibraryCoverTemplate(input): React.ReactElement` 只包含图形；`renderLibraryCover(input, signal?): Promise<Blob>` 返回 <=512000 bytes 的 1920×1080 JPEG。
- `prepareLibraryCoverAssets(preparation, signal?): Promise<{ posters: ReadonlyArray<string>; background: string }>` 最多成功解码九张，下载并发上限二，成功后停止请求剩余候选。
- Canvas 系统字体栈为 `system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`；主标题 700、副标题 600，按 320×180 模板坐标缩放绘制。主标题逻辑字号 32→18，仍超宽则按字素边界省略；用实际 `measureText` 控制宽度。

- [ ] 写失败测试：顺序 `315426987`、一张/四张循环补位、零张拒绝、部分下载失败继续；解码前识别 JPEG/PNG/WebP 尺寸并拒绝超过 1600 万像素的海报，不可识别格式跳过；并发不超过二且成功九张后不再请求。
- [ ] 写编码与清理测试：JPEG 输出上限、质量降至 0.5 仍超限报错、Canvas 编码返回 null 报错、中断释放 object URL；标题绘制与测量使用同一系统字体设置。
- [ ] 在 `apps/dashboard` 运行 `bun --bun vitest run test/library-cover-render.test.ts`，确认失败后实现。Satori 动态导入且 `fonts: []`，无文字 SVG 转 Canvas 后叠字；圆周色相计算采用饱和度权重。
- [ ] 运行测试至 PASS；真实浏览器调用 renderer，以固定海报生成图片并视觉检查右侧倾斜、错位和裁剪；验证中文、Emoji、混合长标题，无网络字体请求。jsdom mocks 不能替代这一步。
- [ ] `bun --filter @oh-my-emby/dashboard build` PASS，检查渲染代码独立分包；提交 `feat: render poster collage covers in browser`。

### Task 5: 前端串行补齐与预览刷新

**Files:** 新建 `covers/coordinator.ts`、`services/library-cover-service.ts`、`hooks/use-library-covers.ts`、`components/library-cover.tsx`、`apps/dashboard/test/library-cover-generation.test.tsx`；修改 `libraries-page.tsx`、`components/{library-list.tsx,library-detail.tsx}`、`apps/dashboard/messages/{en.json,zh-CN.json}`。

**Interfaces:**
- `generateLibraryCover(id, queryClient, signal?): Promise<LibraryCoverSummary>`：prepare→assets→render→upload，成功或 409 时刷新库列表/详情；上传带同源 cookie，不将 JPEG 转为 JSON base64。
- `LibraryCoverCoordinator.enqueue(id, mode: "automatic" | "manual")`、`cancel()`、`subscribe(listener)`；状态为 idle/preparing/rendering/uploading/error，单任务串行，自动尝试集合按本次页面访问维护。
- `useLibraryCovers(libraries)` 调度启用且 missing/stale 的封面；`LibraryCover` 接收 library、状态和手动刷新回调，图片 URL 使用 summary.revision 作查询键。

- [ ] 写失败测试：两库生成互不重叠；React StrictMode effect 重入不重复上传；自动失败后不因 query invalidate 再次尝试；手动重试可以成功；关闭页面中断，重开允许新尝试；409 读取已有图片；旧封面生成期间仍显示。
- [ ] 写 UI 失败测试：无封面占位、现有封面横向显示、详情预览与重新生成按钮、错误/进度国际化、库保存不等待封面、停用库不自动生成。
- [ ] 在 `apps/dashboard` 运行 `bun --bun vitest run test/library-cover-generation.test.tsx test/library-drawer.test.tsx test/page-states.test.tsx` 确认失败，再实现接口与交互，不更改共享 UI 组件。
- [ ] 上述测试与 dashboard typecheck PASS；浏览器实际预览、刷新和上传并检查字体请求与缓存更新；提交 `feat: auto-fill library covers in dashboard`。

### Task 6: Emby 图片协议、端到端验证与文档

**Files:** 新建 `apps/server/src/api/emby-library-covers.ts`、`apps/server/test/emby-library-covers.test.ts`；修改 `apps/server/src/api/{emby.ts,emby-schemas.ts}`、两平台服务接线、`apps/server/test/{cross-platform-contract.ts,workers-routing.test.ts,bun-routing.test.ts}`、`README.zh-Hans.md`、`README.md`、`docs/compatibility/runtime.md`。

**Interfaces:** `libraryCoverImageFields(summary)` 返回 `ImageTags.Primary` 和 `PrimaryImageAspectRatio`；所有虚拟库 DTO 使用此 helper。虚拟库 Primary 图片分支调用任务 2 的 `read`，在普通条目图片解析之前执行，保留现有 token 鉴权。

- [ ] 写失败测试：Views、库详情和其他现有虚拟库 DTO tag 相同，缺图不声明 tag；`/Items/:id/Images/Primary` 和 `/emby` 前缀均可读；GET/HEAD/304，Primary index 0 合法，其他索引/类型 404；未登录和停用库拒绝，普通电影图片路径保持现有行为。
- [ ] 写旧 tag 测试：更新后返回当前封面时必须可重新验证，不将新图不可变地缓存于旧 tag；重开存储、资源缓存丢失后仍可读取持久化图，不需前端重生成。
- [ ] 在 `apps/server` 运行 `bun --bun vitest run test/emby-library-covers.test.ts test/emby-catalog.test.ts test/resources.test.ts`，确认失败，再实现 DTO helper 和资源读取。
- [ ] 运行 `bun run check`、`bun --filter @oh-my-emby/server test:workers`、`./scripts/smoke-workers.sh`，均通过；检查 Workers dry-run bundle 未引入 Satori、字体或图片渲染 WASM。
- [ ] 浏览器创建/打开库，验证海报→Canvas→JPEG→上传→刷新后的真实端到端流程；用认证 HTTP 请求读取对应 Emby DTO 和图片。实际客户端未验证时明确记录该限制，不能将 HTTP 测试描述为客户端验证。
- [ ] 更新说明：需打开 Dashboard 才能生成、图片持久化位置、系统字体差异、手动刷新；提交 `feat: serve library covers to Emby clients`。

## 执行前交接

推荐在当前会话按任务顺序直接实施，各步骤共享仓储、生成清单与协议接口，顺序执行便于保持一致。用户审核本计划并选择直接实施或子代理实施后，先使用 using-git-worktrees 检查/准备隔离环境，再按执行方式进入相应技能流程。
