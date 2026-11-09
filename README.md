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

- 首页第一屏是**索引源卡片**（渐变描边 + 外发光，纯 CSS）：「由 DSH 制作」徽章、**全部 / 国内 / 国际**三个索引源切换、源地址 + 一键复制。
- `index.html` 690 B；`style.css` / `app.js` 为**同源**资源（Pages 直接提供，部署即生效）。第三方图标仍走 jsDelivr 的 npm 直链（npm 版本不可变，不存在缓存问题）。
- 页脚：交流 QQ 1689170897。
- **多语言**：右上角切换 中文 / English / 日本語 / 한국어 / Русский；ja/ko/ru 由 CI 里的 Google Translate 生成（`crawler/translate.mjs`，按内容哈希缓存，失败即跳过不发布）。
- 卡片**点击打开详情**：中英对照 + 类别/版本/作者/发布/来源/包名 + 安装命令一键复制；卡片本身不再放「主页」按钮（链接在详情里）。

## 索引源：一个链接就够了

| 索引源 | 内容 | 国内实测 |
|---|---|---|
| **`index.zh.json`** | 全部 1 万余条，中英双语（推荐加这一个） | 4.3 MB，**gzip 后 1.08 MB / 1.8 秒** |
| `index.<lang>.json` | en / ja / ko / ru，同一份目录的其它语言 | 各 4.3–4.8 MB |
| `index.json` | 五语合并文档（站点与工具用，最大） | 11.6 MB，gzip 2.2 MB / 24 秒 |

**关键事实（实测）**：GitHub Pages 对 JSON 走 `Content-Encoding: gzip`，所以 4.3 MB 的文件实际只传 1.08 MB。用不带 `Accept-Encoding` 的 `curl` 测会得到「40–88 秒」的假象。

不建议、也不需要的做法（都验证过不可用）：
- ModelScope 数据集 URL：`/resolve/` 与 API 都 **302 → cdn-lfs-cn-1**，DSH 的加载器拒绝重定向；
- 品牌域 `dsh.jiangjiangze.icu`：国内被限速到约 4 KB/s；
- jsDelivr 镜像：该路径返回 **403**；
- 分片（多链接）：能满足速度，但配置要写 6 条，已撤掉；
- Cloudflare Worker：明确不使用。

## 双语与分类

- 每个插件都有 `{en, zh}` 标题与简介，并被归到一个声明过的类别（9 类：safety / ui / media / integrations / memory / models / automation / devtools / other）。
- 中文来源优先级：**包自带 `locale/zh.json`** → **本仓库 `data/zh-overrides.json`**（可按 `version` 钉版）→ 兜底英文并标 `zh-fallback`（当前 0）。当前 38/38 双语：`zh-native` 13 + `zh-override` 25。
- 标签写明来源（`zh-native` / `zh-override` / `zh-fallback`），数量统计进 `dist/stats.json`。
- 分类规则在 `crawler/crawl.mjs` 的 `CATEGORY_RULES`，**必须带词边界**——裸子串会把 `inspired` 命中 `ide`、把主题插件误判成开发工具。
- 不编造翻译：没有机器翻译，全部来自作者 locale 或仓库内人工整理。
- **不在本机跑任何服务**：爬取、校验、发布都在 GitHub Actions；本地 `node crawler/crawl.mjs --dry-run` 只是一次性脚本。

## CI（三段流水线）

| 工作流 | 触发 | 做什么 |
|---|---|---|
| `crawl.yml` | 每 3 小时 + 手动 | 三分片采集 → 合并目录 → 生成多语言/浏览分片/资源 → **离线 + 在线发布门禁** → Git Data API 提交 `main` → 显式触发 `deploy` |
| `ci.yml` | 每次 push / 每个 PR | 门禁自测 → 官方 `@deepseek-ai/dsh-plugin-market-index` 校验 → 页面预算与引用检查 → registry 回查 → `--dry-run` 冒烟（守住 main 与人工 PR） |
| `deploy.yml` | main 的 `site/**`、`dist/**` 变化，或由 crawl 派发 | 双端发布：GitHub Pages + Cloudflare Pages（`wrangler`） |
| `dependabot.yml` | 每周 | GitHub Actions 版本升级 PR（人工审） |

**发布纪律**：`crawl` 和 `translate` 共用 `catalog-publish` 并发组，避免两个写入者同时基于旧 `main` 创建提交；完整发布门禁在写入 `main` 前执行，push 触发的 `ci` 作为发布后回归检查。

**两个必须知道的 GitHub 行为**（都已在代码里绕过）：

1. **用仓库 `GITHUB_TOKEN` 写入 `main` 不会触发其它 workflow**（防递归）→ 所以 `crawl` 提交后显式 `gh workflow run deploy.yml`，不指望 push 事件。
2. 当前 `crawl` 走 Git Data API 直接写 `main`，不再创建 crawl PR；因此发布门禁必须在写入前执行，不能依赖 push 后才运行的 `ci` 来阻止错误版本上线。


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

本仓库的爬虫与站点代码以 **GNU General Public License v3.0 或更新版本**（`GPL-3.0-or-later`）发布，全文见 [`LICENSE`](LICENSE)。

索引里的条目版权归各包作者；本仓库只写元数据，不再分发任何包。这些第三方包的元数据与许可**不因本仓库的许可而改变**，GPL-3.0 不外溢到索引内容。
