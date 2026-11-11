# zcode/ — ZCode 插件登记册

只读的插件元数据登记站，部署在 **https://zcode.jiangjiangze.icu**（Cloudflare Pages 项目 `zcode-market`）。

它回答三个问题：这台机器的 ZCode 能看见哪些插件、每个插件从哪来（本地缓存 / 客户端内置 / 官方 CDN 归档 / git 仓库）、装之前有什么静态风险（hooks / MCP / LSP / npm 安装脚本）。

## 目录

| 路径 | 作用 |
|---|---|
| `build.mjs` | 生成器：读本机 ZCode 目录 → `site/` |
| `template.html` | 单文件站点模板（内联 CSS/JS/数据，file:// 可直接打开） |
| `site/index.html` | 构建产物（提交进仓库，CI 只部署不重建） |
| `site/catalog.json` | 机器可读镜像 |
| `site/stats.json` | 市场统计、来源分布、缓存龄 |
| `NOTICE.md` | 第三方元数据的授权边界 |

## 构建

```sh
node zcode/build.mjs            # 默认输出 zcode/site
node zcode/build.mjs --out /tmp/site
```

数据源全部来自本机，构建过程不联网：

1. `zcode plugins list --json --available` — 目录与安装状态；
2. `~/.zcode/cli/plugins/marketplaces/<m>/marketplace.json` — 版本、来源、sha256、中英描述、分类、关键字；
3. `~/.zcode/cli/config.json` 与工作区 `.zcode/config.json` — user / project 两层启用状态（project 覆盖 user）；
4. plugin-on-demand 技能的 `host-health.json` — 构建时的主机可达性（决定 blocked / ready）。

环境变量：`ZCODE_CLI`、`ZCODE_PROJECT_CONFIG`、`PLUGIN_ONDEMAND_CACHE`。

## 部署

`.github/workflows/zcode-deploy.yml` 只在 `zcode-market` 分支上触发，用仓库已有的 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 部署到 Pages 项目 `zcode-market`；自定义域名 `zcode.jiangjiangze.icu` 的 CNAME 指向 `zcode-market.pages.dev`。

没有走 GitHub Pages：本仓库的 Pages 站点属于 DSH 索引（`dsh.jiangjiangze.icu` / `jingjiangze.github.io/dsh-market`），同一仓库的自定义域只能有一个，因此新站只走 Cloudflare Pages 分支部署。

## 已知边界

- 快照不是实时数据：`generatedAt` 之后目录若变化，需要重跑 `build.mjs` 并提交。
- 官方市场的 zip 有 sha256；社区 git 源大多没有校验字段。
- 构建时 `github.com` 不可达，所以 2,100 条 git / git-subdir 条目显示 `BLOCKED`；网络恢复后重跑构建即可刷新。
- 安装命令指向本机 plugin-on-demand 技能（`load.mjs`），仅对装了该技能的工作区有效。
