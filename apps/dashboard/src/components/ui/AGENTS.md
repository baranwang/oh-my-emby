# shadcn UI 组件约束

本约定适用于本目录及其子目录中的所有组件代码。

- 组件必须通过官方 shadcn CLI 安装或覆盖。禁止 agent 直接新建、编辑、重写组件代码，包括样式、文案、props、行为和导出。
- 不得通过 `apply_patch`、脚本、复制官方源码或手写替代组件绕过 CLI。
- 使用 Bun 和项目已安装的 shadcn CLI，沿用现有 `components.json` 配置；不得擅自更换 preset 或主题 token。
- 业务逻辑、国际化、交互和布局适配放在本目录之外，通过组件公开 API 组合，并遵守项目的 `shadcn/no-restyle` 规则。
- CLI 无法满足需求或执行失败时，说明限制，不得退回手写组件。

在 `apps/dashboard` 目录执行：

```sh
# 安装组件
bunx --no-install shadcn add <component> --yes

# 覆盖指定组件
bunx --no-install shadcn add <component> --overwrite --yes
```
