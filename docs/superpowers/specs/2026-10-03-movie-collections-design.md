# 电影合集支持设计

日期：2026-10-03

状态：用户已确认同时支持 TMDB 自动合集与上游 Emby BoxSet；本文待审阅，尚未开始实现。

## 目标与成功标准

客户端通过标准 Emby 查询看到电影合集，打开合集后浏览当前可访问的成员电影，并沿用已有电影详情、版本选择和播放流程。支持 TMDB 自动合集与上游自定义合集；相同 TMDB 合集跨服务器合并，无可靠共同身份的自定义合集独立保留。

合集有稳定的本地 ID、名称、简介、封面、背景图及可见成员数量。停用媒体库、来源或服务器后，合集查询立即遵守新的访问范围。没有可见成员的合集不显示。合集不计入 MovieCount，不产生可播放的 MediaSources。

沿用当前单用户、按需联邦查询和持久缓存架构，同时支持 Bun/SQLite 与 Workers/D1。保持当前电影 ProviderIds 对客户端的透传策略；内部识别合集不依赖客户端读取电影外部 ID。

## 方案选择

采用本地合集实体和带来源的成员关系。它能统一 TMDB 与 BoxSet，复用电影规范身份与播放资源，并在读取时校验访问范围。

只透传上游 BoxSet 无法生成上游没有的 TMDB 合集，也无法保证跨来源合并和本地成员 ID。每次请求即时拼接 TMDB 合集则缺少稳定关联和分页，并把外部服务延迟叠加到浏览请求，因此不采用这两种方案。

## 身份与持久化

新增独立的 Collections 领域服务，由 Federation 调用；合集数据访问通过 Repositories，两个平台实现相同接口和契约测试。

新增迁移 `0006_movie_collections.sql`，保存：

- 合集实体：本地 ID、可选 TMDB collection ID、创建和更新时间。TMDB ID 唯一，使用独立 `tmdb:collection` 身份域，不能与电影 ID 共用。
- 上游合集来源：server ID、catalog namespace、generation、upstream BoxSet ID、本地合集 ID、来源元数据。无 TMDB ID 的合集以来源身份生成稳定 ID，不按名称合并。
- 成员证据：合集 ID、规范电影 ID、来源类别，以及支持该关系的服务器、generation、电影 source item 或上游合集来源；同一电影允许属于多个合集。
- 合集别名：先以来源身份发现、之后确认 TMDB 身份时合并到 TMDB 合集，旧 ID 仍可解析。成员电影的 canonical aliases 在读取时同样解析。

TMDB 关系属于电影元数据证据；上游自定义关系属于具体 BoxSet 的成员证据。两种证据独立更新，一方刷新不能删除另一方关系。没有明确身份或身份冲突时保留独立来源合集。

合集与电影数据分离，避免创建假的 SourceItem 或 MediaVersion 来满足电影播放模型。Emby DTO 通过一个明确的合集视图适配输出，不把 BoxSet 当作可播放 Movie。

## TMDB 数据流

电影元数据优先使用 TMDB movie ID；只有 IMDb ID 时通过 find 获取 TMDB movie ID，再读取电影详情，因为 find 结果不能保证包含 `belongs_to_collection`。

解析电影详情中的 `belongs_to_collection`，建立合集身份和成员证据。读取 `/collection/{id}` 获取本地化名称、简介、海报、背景图和 parts；使用现有 TMDB credential、请求限时、语言规则和缓存策略。同一合集请求合并，避免每部电影重复获取合集详情。

合集展示语言沿用固定语言或客户端语言规则；缓存按语言区分。成员关系不随展示语言变化。成功刷新电影详情且 `belongs_to_collection` 为 null 时，移除该电影旧的 TMDB 合集关系；超时、429、无效响应或认证失败不视为“无合集”，保留可用旧证据。

TMDB parts 只作为候选成员，不能直接输出不存在于上游的影片。打开合集时对候选电影 ID 在当前启用的电影来源中执行有预算的精确查询，复用现有身份与资源合并。多个上游副本输出为一部电影的多个版本。

关闭 TMDB 时不继续生成或显示仅由 TMDB 证据支持的合集；有上游 BoxSet 证据的合集仍可浏览，图片和文本回退上游数据。重新开启后可以复用未过期缓存。

## 上游 BoxSet 数据流

按需向上游查询 `IncludeItemTypes=BoxSet`，允许从用户 Views 的合集入口或服务器范围发现 BoxSet，不能假设 BoxSet 必然位于电影根目录下。始终使用现有上游用户认证和 UA 策略。

读取 BoxSet 的 ProviderIds：仅明确表示合集的 TMDB ID用于跨来源合并，不能用成员电影的 TMDB ID代替。保留没有外部 ID的自定义合集名称与图片。

使用上游 BoxSet ID作为 ParentId 查询其 Movie 成员。发现成员后仍需证明影片属于当前启用的电影来源库：使用已有 source membership 或针对电影库的精确来源查询验证。不能把 BoxSet 所在入口当作电影库绑定，也不能把上游成员全部授权为可访问。

成员快照只有在相关来源扫描完整成功时才替换；请求失败、截断或预算耗尽时只增加已证实成员，不能删除未观察到的成员。停用来源、generation 变化或隔离记录会在读取时使其证据失效。

## Emby 接口与客户端行为

在现有 `/Items` 与 `/Users/{user}/Items` 查询中支持 `IncludeItemTypes=BoxSet`。支持电影虚拟库范围和全局合集范围；混合 `Movie,BoxSet` 查询在同一排序与分页流程中输出两种类型，不能分别分页后简单拼接。

`GET /Items/{collectionId}` 及用户详情路径返回 `Type=BoxSet`、`IsFolder=true`、稳定 Id、名称、简介、ImageTags 和当前已证实可见成员数。只有打开合集的成员查询才把 ParentId 当作合集 ID；现有 CollectionFolder、Series、Season 的 ParentId 行为保持各自含义。

`ParentId={collectionId}&IncludeItemTypes=Movie` 返回规范电影 DTO，支持搜索、排序、StartIndex、Limit和已有用户状态过滤。详情、PlaybackInfo、图片和视频请求继续使用电影本地 ID。对没有媒体类型过滤的合集成员查询，默认返回 Movie。

用户 Views 增加稳定的全局合集入口，`Type=CollectionFolder`、`CollectionType=boxsets`；电影库内部也可查询 BoxSet。入口 ID与合集 ID、虚拟电影库 ID分离。空入口不显示。

合集图片使用现有 TMDB 图片规则，回退有效上游 BoxSet 图片；Infuse 图片代理与 GET/HEAD 兼容策略同样适用。合集本身不能调用电影 PlaybackInfo 或视频流接口。

本次支持只读浏览；不新增客户端创建、编辑、删除合集接口。电影收藏与播放状态保持既有语义，不把合集收藏隐式传播到成员。

## 发现范围、性能和更新

沿用父架构的按需发现，不新增后台全库扫描。TMDB 自动合集从已浏览、搜索或详情刷新过的电影中发现；上游合集在访问合集入口时分页发现。空缓存时不能承诺列出上游所有电影对应的 TMDB 合集，这是当前按需架构的明确边界。

打开已发现的 TMDB 合集可按 parts 精确补齐尚未缓存的可访问成员。遵守现有 fanout、最大物化条数、请求限时和429退避；多 ID查询使用上游已验证支持的批量格式，不支持时采用受限逐项查询。预算耗尽返回已发现结果并保留内部不完整状态，下次请求可继续发现。

TotalRecordCount 和 ChildCount表示当前查询已证实可见的规范成员数，不能使用 TMDB parts 总数或上游未过滤总数。完整扫描后的分页稳定；不完整扫描保留已物化集合，不因暂时不可用改写为完整空集合。

首次合集请求不能同步刷新整个电影库的 TMDB 数据。缓存读取、电影元数据刷新及合集发现分开，避免重现详情需要等待大量上游查询的问题。

## 访问与失效规则

所有列表、详情、成员和图片请求都先验证当前启用范围。全局范围是当前启用电影虚拟库的并集；某电影库范围只包含该库可访问的成员。共享合集可有多来源，任一有效电影证据足以保留对应成员，禁用另一个来源不能误删整部影片。

合集成员写入事务携带 generation fence；切换上游用户或catalog后，不接受旧请求写入。关系读取排除quarantine并解析canonical aliases。跨类型混合库依然只查movies绑定，不进入series来源。

语言或TMDB设置更新使相关展示缓存失效，不改变稳定合集ID。成员或库配置改变后使相关合集查询快照失效；避免旧分页结果继续暴露已停用成员。

## 验证与验收

- 共享仓库契约：TMDB合集唯一身份、来源合集别名、成员证据独立更新、电影别名、generation fence、禁用与隔离过滤，SQLite/D1结果一致。
- TMDB：movie ID优先、IMDb find后读详情、无合集、移除关系、语言缓存、设置变更、429/超时保留旧证据、parts不可直接创建电影。
- 联邦：同TMDB合集跨上游合并、自定义同名合集独立、跨库成员过滤、混合库类型隔离、部分失败不删除成员、跨来源电影版本保留。
- Emby：Views合集入口、BoxSet单独与混合查询、合集详情、ParentId成员、排序分页与可见数量、空合集隐藏、图片GET/HEAD、合集不可播放、现有电影与剧集回归。
- 实际客户端：用当前配置验证至少一个TMDB合集和一个上游BoxSet（上游有时）；分别记录Rex/Infuse的列表、成员和电影播放结果。若当前来源没有某种合集，使用测试覆盖并明确实测范围，不宣称已验证客户端画面。
- 完整项目测试、Workers/D1测试、typecheck、build和提交hooks串行完成；不变更用户现有媒体库配置来制造测试合集。
