<p align="center">
  <img src="assets/brand/logo.svg" alt="OhMyEmby logo" width="96" height="96">
</p>

<p align="right"><a href="README.md">English</a></p>

# OhMyEmby

OhMyEmby 是一个可自行部署、兼容 Emby 的虚拟服务器。最多连接十台 Emby 服务器，选择其中的媒体库，并把匹配的条目显示为同一个项目下的多个可选媒体版本。

> 这是早期 MVP。协议和部署已有自动化检查，但真实媒体客户端的播放以及远程 Cloudflare 部署尚未验证。参见 [SenPlayer 兼容性记录](docs/compatibility/senplayer.md)。

## 功能

- 配置多台 Emby 服务器，每台可设置有序的连接地址、凭据和 User-Agent 策略。读取请求在线路失败时，可以尝试另一个已验证的地址。
- 只有兼容的外部 ID 或剧集身份证明是同一条目时，才合并电影、剧集和单集。无法识别的条目保持独立；匹配的副本显示为可选版本。
- 保存一个本地用户的已观看、收藏和续播状态，并异步把写入同步到匹配的上游条目。
- 可选地使用 TMDB 和 Trakt 补充标题与图片，上游 Emby 元数据作为最终回退。
- 将视频播放重定向到所选上游源。OhMyEmby 不代理、不转码视频数据，因此播放客户端必须能够访问重定向后的 URL。

目录请求按需联合查询并缓存；应用不会在后台遍历每个上游媒体库。一次部署只提供一个虚拟 Emby 服务器和一个本地用户。不同用户或用户组请部署独立实例。

## Docker 快速开始

在本仓库的检出目录中执行：

```sh
docker compose pull
docker compose up -d
curl --fail http://127.0.0.1:3000/health
```

Compose 使用 `ghcr.io/baranwang/oh-my-emby:latest`，并把 SQLite 数据保存在命名卷中。如果镜像尚未发布、想先使用当前检出的代码，可以在本地构建：

```sh
docker build -t oh-my-emby:local .
IMAGE_REPOSITORY=oh-my-emby IMAGE_TAG=local docker compose up -d
```

> 未初始化实例的第一位访问者可以成为所有者。创建账号前请限制访问。

容器绑定在 `127.0.0.1:3000`。要从其他设备访问，请在前面放置 HTTPS 反向代理，并保留公开的 `Host` 请求头；浏览器会话使用 `Secure` Cookie。不需要配置公开来源、代理或上游主机允许列表的环境变量。Docker 可以连接管理员配置的局域网地址；容器内的 `localhost` 指容器自身，不是 Docker 宿主机。备份和升级说明见 [Docker 部署](docs/deployment/docker.md)。

打开 `https://your-domain/dashboard`，然后：

1. 首次访问时创建本地所有者账号。
2. 添加 Emby 服务器及其连接地址。保存时会测试连接并加载源媒体库列表；如果发现失败，已保存的服务器仍可稍后重试。
3. 用要公开的源媒体库创建虚拟媒体库。TMDB 和 Trakt 可以稍后在“系统”中配置。
4. 在兼容 Emby 的客户端中添加 `https://your-domain`（不要包含 `/dashboard`），并使用本地所有者凭据。

视频重定向会把上游 URL 暴露给客户端。如果该 URL 是私有地址，或需要客户端无法发送的请求头，该客户端可能无法播放。没有安全且客户端可访问的 URL 时，图片和字幕也可能不可用。上游凭据会保留以支持无人值守访问，因此请保护部署中的 SQLite 卷或 D1 数据库。

## Cloudflare Workers

[![部署到 Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/baranwang/oh-my-emby)

按钮会部署到你自己的 Cloudflare 账号。构建命令和限制见 [Workers 部署指南](docs/deployment/workers.md)。Workers 不能连接私有地址、localhost 或 IP 字面量形式的上游地址；这些服务器请使用 Docker。

## 开发与验证

开发需要 Bun 1.4.2。Docker 用户不需要在宿主机安装 Bun。

```sh
bun ci
bun run check
bun --filter @oh-my-emby/server test:workers
./scripts/smoke-workers.sh
```

Docker 构建和冒烟测试需要正在运行的 Docker daemon：

```sh
docker build -t oh-my-emby:verify .
./scripts/smoke-docker.sh
```

本地 Workers 冒烟测试使用 workerd 和本地 D1，不会部署到 Cloudflare。远程兼容性和运行时测量记录在 [运行时证据](docs/compatibility/runtime.md)。Dashboard 位于 `/dashboard`；兼容 Emby 的路由位于源站根路径和 `/emby` 下。

## 许可证

[AGPL-3.0](LICENSE)
