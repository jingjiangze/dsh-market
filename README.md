# dsh-market · DSH 插件市场索引（自动爬取）

为 DeepSeek Harness（DSH）的「插件 → 发现」提供一份**自动生成、格式合规**的索引源。

- 主源（GitHub Pages，实测最稳）：`https://jingjiangze.github.io/dsh-market/index.json`
- 品牌域名（Cloudflare Pages）：`https://dsh.jiangjiangze.icu/index.json`
- 两个地址内容同源：都来自本仓库 `site/`，由 CI 生成后提交

## 加进 DSH

「插件 → 发现 → 添加索引源」，两个都加（互为主备）：

```
https://jingjiangze.github.io/dsh-market/index.json
https://dsh.jiangjiangze.icu/index.json
```

> 为什么主源选 GitHub Pages：2026-11-02 本机直连实测 **3/3 成功，0.61–0.81 s**；同一份索引走 Cloudflare Pages 自定义域名时 **3 次里 1 次卡在 25 s 只收到 538 B**、其余 3.8–17.5 s（CF 边缘境内无节点，直连不稳；走代理 2/2 成功 1.9–2.9 s）。DSH 的 fetch 超时是 15 s，所以把 Pages 当人读站点、把 GitHub Pages 当机器源，两边都不丢。

## 它是什么 / 不是什么

- 是：从 **npm 公共源**爬到的、**声明了 `dsh.bundle.patch`** 且 `engines.dsh` 满足当前运行时的包的元数据清单（分类、多语言描述、图标直链、精确版本）。
- 不是：不是代码托管，不镜像任何包，不对任何插件背书。装什么、跑什么，以包本身为准。
- 索引里**只有元数据**：`source.type = npm`，安装走你本机 pnpm + 你自己的 registry 配置。

## 爬取与准入（`crawler/crawl.mjs`，零依赖）

```
node crawler/crawl.mjs --selftest     # 门禁自测（正例 + 反例）
node crawler/crawl.mjs                # 爬取并生成 dist/
```

两段式，先便宜后贵：

1. **发现**：`registry.npmjs.org` 关键词检索（`keywords:dsh-plugin`、`keywords:deepseek-harness`、`keywords:dsh`）。
2. **初筛**（每包 1 次 `/<name>/latest`）：必须声明 `dsh.bundle.patch`；不得含 `preinstall`/`install`/`postinstall`。
3. **定版**（入选包再取完整 packument）：取**最新稳定版**且满足 `engines.dsh`；未声明 `engines.dsh` 的一律**不收**（不猜"应该能跑"）；发布不足 `MIN_AGE_DAYS`（默认 3 天）的不收（pnpm 的 `minimumReleaseAge` 会扣住它们，写进索引用户也装不上）；许可为空或 `NOASSERTION`/`UNLICENSED` 的不收。

产出：

| 文件 | 内容 |
|---|---|
| `dist/index.json` | format 1 索引（DSH 唯一读的东西） |
| `dist/index.sidecar.json` | format 1 装不下的东西：`dist.integrity`、provenance、体积、生效的门禁 |
| `dist/rejections.json` | 每个被排除的包 + 原因（可复盘，不静默丢） |
| `dist/stats.json` | 候选数 / 初筛数 / 收录数 / 拒绝原因分布 / 索引字节数 / 耗时 |

环境变量：`NPM_REGISTRY`、`SEARCH_REGISTRY`、`DSH_RUNTIME_VERSION`、`MIN_AGE_DAYS`、`MAX_PLUGINS`、`MAX_CANDIDATES`、`CONCURRENCY`、`SEARCH_QUERIES`。

### 已知的爬取坑（踩过）

- **npmmirror 不支持 `keywords:` 语法**：`registry.npmmirror.com/-/v1/search?text=keywords:dsh-plugin` 返回 `total=0`，而 npmjs 返回约 11.9k。所以**发现阶段固定用 npmjs**；manifest 阶段可换镜像加速。
- **不能信 latest**：一个包可能同时有多个兼容版本，`latest` 未必兼容当前运行时，所以定版要读完整 packument。
- **未声明 `engines.dsh` ≠ 兼容**：DSH 的安装侧会用真实包的 `engines` + `peerDependencies` 再判一次，索引里谎报兼容比不收更伤口碑。

## 站点（`site/`）

- `index.html` **833 字节**（预算 <1KB，CI 会挡），`style.css` 2.6 KB 外链，**没有任何图片/字体/JS**。
- 配色按 DSH 自己的语义 token 命名（`--dsw-alias-bg-base` / `bg-layer-1/2` / `border-l1/l2` / `brand-primary` / `label-primary|secondary`），字体栈首选 DSH 的品牌字体 Montserrat，缺字体时回落系统字体——所以不下载任何字体文件。
- 图标不落盘：索引里直接写 `https://cdn.jsdelivr.net/npm/<pkg>@<ver>/<icon>`（镜像直链）。
- `_headers` 给 Pages 加 CORS 与缓存头（`index.json` 300 s，对 DSH 的 10 分钟内存缓存足够）。

## CI（三段流水线）

| 工作流 | 触发 | 做什么 |
|---|---|---|
| `crawl.yml` | 每日 03:17 UTC + 手动 | 爬取 → 组装 `site/` → **只有目录变化才**推 `crawl/<run_id>` 分支并开 PR，不直推 main |
| `ci.yml` | 每次 push / 每个 PR | 门禁自测 → **用官方 `@deepseek-ai/dsh-plugin-market-index` 真验证器**校验索引 → 页面预算与引用检查 → registry 回查 → `--dry-run` 冒烟；PR 来自 `crawl/` 分支且全绿时**自动 squash 合并** |
| `deploy.yml` | main 的 `site/**`、`dist/**` 变化 | 同时发布 GitHub Pages 与 Cloudflare Pages（`wrangler`），只有通过 `ci` 的提交才会走到这里 |
| `dependabot.yml` | 每周 | GitHub Actions 版本升级 PR（人工审） |

`ci` 里的检查（`crawler/validate.mjs`）：

1. `parseMarketIndex()` —— 与 DSH 运行时同一份校验器，不是自己重写；
2. `site/index.json` 必须与 `dist/index.json` **逐字节一致**（防止发布物与验证物脱节）；
3. `site/index.html` < 1024 B，`style.css` 存在；
4. 页面里不允许出现 `127.0.0.1` / `localhost` / `file://` / 内联图片字体；
5. 每条 plugin 的 `name@version` 在 registry 上真实存在、仍声明 `dsh.bundle.patch`，且 `engines.dsh` 与索引里写的一致（防止**索引漂移**——DSH 安装侧会用真实包再判一次兼容性）。

本地复现（不需要网络可加 `--offline`）：

```bash
npm i --no-save @deepseek-ai/dsh-plugin-market-index@0.2.1-rc.5
node crawler/crawl.mjs --selftest
node crawler/validate.mjs
node crawler/crawl.mjs --dry-run
```


## 已知限制

- **索引没有签名**：format 1 里没有 signature / digest 字段，DSH 不验签。篡改只能靠外部核对 `dist/index.json` 的 sha256（见每次提交与 `stats.json`）。
- **没有 upgrade 流程**：DSH 侧「有新版」只显示 `update-available`，升级 = 卸载 + 重装。
- **索引是单文档全量读**：超过 ~5k 条要考虑拆多源（官方口径：20k 条 ≈ 7.6 MiB，反序列化约 35 ms）。
- **只覆盖 npm**：不发布到 npm 的插件（只在 GitHub 的）暂不收录；后续可加 `source.type=git` + commit 固定。
- **不做安全审计**：门禁只保证「是个能装的 bundle、版本兼容、许可清楚、不跑安装脚本」，不代表代码安全。

## 许可

本仓库的爬虫与站点代码 MIT。索引里的条目版权归各包作者；本仓库只写元数据，不再分发任何包。
