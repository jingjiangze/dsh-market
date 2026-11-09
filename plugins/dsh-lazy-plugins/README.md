# 按需加载插件

> 市场里有 1.3 万个插件，装进 profile 的每一个都会把工具塞进每次请求。这个插件让 agent **需要时才装、当场就能用、用完留着也不花钱**。
>
> TL;DR — the agent finds, installs and calls market plugins on demand; loaded tools stay behind `invoke`, so the visible tool set (and the prompt cache) never moves.

| | |
|---|---|
| 包名 | `@local/dsh-lazy-plugins` |
| 版本 | v3.53.0 |
| 形态 | Host 插件 + Web 客户端半（官方插件页新增一个「按需加载」tab） |
| 常驻成本 | ≈ 585 tokens（一行描述 38 + 参数 547）+ 一段约 90 tokens 的系统提示，技能正文按需加载 |
| 数据源 | 市场索引（13,854 条）+ 站点 install-facts（818 B）+ 社区 tags + 31 类领域库 |

## 为什么

DSH 的工具面是**每轮固定成本**。装上 8 个插件、工具涨到 81 个时，schema 就有 74 KB ≈ **18,600 tokens**，而且任何一次工具面变化都会重算提示词前缀——缓存直接失效。

按需加载把这个成本变成可选的：

| 做法 | 提示词里的工具 | 当场可用 |
|---|---|---|
| 传统：装进 profile 并启用 | 全部（每轮都付） | 是 |
| **本插件默认（proxy）** | **只有入口那一个** | **是**（经 `invoke`） |

实测：把已装插件的工具全部纳入按需后，工具面 **81 → 56**，每轮省 **≈ 3,900 tokens**；一次 `load` 的代价是 1.9–3.0 s（其中 pnpm 占绝大部分）。

## 功能

**选择**
- `ensure`：一句话需求 → 自动挑插件；只在「分数 ≥ 40 且领先第二名 1.5×」时才自动装（实测精度 0.90）
- `suggest` / `search`：候选列表；中文描述 + 英文 tags 双向匹配（`text to speech` 能找到「语音朗读」）
- `recipes`：31 个领域的已验证短名单，**0 网络、2–12 ms**（领域 = 站点分类；`voice`/`sheet` 这类短名自动映射）

**安装与使用**
- `load`：安装并激活；默认 `proxy`（工具不进模型视野），`now` 原生可见，`session` 只装不启
- `invoke`：调用被隐藏的工具（宿主作用域执行，实测 4–5 ms）
- `adopt { all: true }`：把**已装插件**也纳入按需——不需要知道工具归属，规则是「全局视图里的插件工具」；`unadopt` 全部恢复

**维护**
- `outdated` / `update`：查可更新版本并安装（走宿主原生 `updateBundle`：换版前校验存在性+bundle+engines，失败自动装回）
- `verify`：只读体检——运行时版本、每个依赖的 `engines.dsh` 裁决、deps↔bundles↔lockfile↔node_modules 一致性、孤儿/悬空链接
- `advise`：工具面成本、缓存命中、使用分、最近动作耗时（p50/p95/max）
- `list` / `reload` / `unload` / `release` / `uninstall` / `tune`

**常驻不删**
装上的插件默认保留——proxy 模式下它不占提示词空间。只有你明确要求才 `release`；`advise` 会提示「自动池里 30 天没用」，但**不会自动删**。

## 安装

```sh
# 官方插件市场 / 宿主命令（推荐）
dsh plugin --profile desktop add dsh-...        # 或其他能拿到本包的方式

# 本地开发
dsh plugin --profile desktop add link:/path/to/dsh-lazy-plugins
```

装好后打开 **设置 → 插件**，会多出「按需加载」tab；页面上的启停/重载/更新/纳入按需/移除直接操作本 profile。

## 配置

`cordis.patch.yml` 里都可以改（也出现在设置页的自动表单里）：

| 键 | 默认 | 作用 |
|---|---|---|
| `defaultActivate` | `proxy` | `load` 的默认激活方式 |
| `autoSelectScore` / `autoSelectMargin` | `40` / `1.5` | 自动安装的门槛与领先倍数 |
| `prefetch` / `prefetchLimit` | `true` / `2` | 候选 tarball 预取（命中后走 `file:` 安装） |
| `autoUpdate` / `autoUpdateMax` | `pool` / `3` | 自动更新策略：只更新自动池、每次启动最多 3 个、绝不更新自己 |
| `domainBoost` | `1.12` | 命中领域库的候选加权（只做先验，不改判定门槛） |
| `bridgeWeight` / `categoryBoost` | `0.4` / `0.3` | 双语桥接 / 同分类软加权 |
| `indexUrlFallback` | 站点索引 | profile 没配任何索引时的兜底 |
| `strictUsable` | `false` | 装完若没观察到工具/技能是否回滚（默认关：事件型/挂件型插件看不见） |

## 工作原理

1. **入口只有一个工具**。`lazy_plugin` 常驻；它的细节写在 `skills/lazy-plugins/SKILL.md`，模型需要时才加载（Claude 式渐进披露）。
2. **所有会话都被提醒**。插件在 `systemPrompt` 注册一段约 90 tokens 的固定文本：能力缺口（视频/文案/图像/语音/PDF/表格/翻译/导出/数据库/部署）先去市场找；**普通改代码不要去翻**。
3. **proxy 不破坏缓存**。`load` 之后用 `agent.ctx.tools.restrict({deny})` 把新工具从模型视野隐藏，`invoke` 在宿主作用域执行——工具面与提示词前缀都不变。
4. **三份目录，互不阻塞**。格式 1 索引（搜索/engines）、install-facts 差分（installable，818 B）、社区 tags（英文词）+ 领域库；任何一份拉不到都只是少一点信号，不会让动作失败。
5. **写操作串行**。所有 profile 变更走同一条 `profileWrite` 链；安装结果不是 `applied`/`restart-required` 就回滚。

## 兼容性

- **运行时版本由 asar 读**（实测 `0.2.2-rc.1`），每个依赖的 `engines.dsh` 用自写 semver 子集裁决（含 npm 的 `-0` 上界与预发布排序），`verify` 一条命令给出结论；
- 应用自动升级后，启动时会静默体检查一次，结果在 `advise.runtimeHealth`；不兼容的包会被点名并给出可安装的兼容版本；
- 官方 bundle（`availability !== 'profile'`）结构性保护：任何动作都拒绝卸载。

## 性能（本机实测，2026-11-08）

| 动作 | 耗时 |
|---|---|
| `recipes`（31 领域） | 2–12 ms |
| `suggest` / `search` | 150–440 ms |
| `verify` | 47 ms |
| `list` / `advise` | 140–230 ms |
| `invoke` | 4–5 ms |
| `load`（已预取） | 2.7 s（pnpm 1.9–3.0 s） |
| `adopt`（含开关一次） | 1.7–2.3 s |
| `update` | 6–17 s（按包体积） |

## 已知限制

- 在 0.2.2-rc.1 上 `restrict()` 是**全或无**：一个未知名字整批拒绝。`ops_*` PTC 家族不在 restrict 域内，这部分工具**无法**被 proxy 隐藏（本机 33 个目标里 22 个可隐藏、11 个跳过）。
- 逐 bundle 的开关法**学不到工具归属**（禁用 profile bundle 不改变工具视图），所以 `adopt { name }` 只对"本工具刚装过、有安装差异"的包可靠；批量用 `adopt { all: true }`。
- `release` 一个 git 源包要 10–20 s（pnpm 重新解析）。
- 索引里的幽灵条目仍存在（install-facts 只覆盖有探测结果的包）。

## 文档

- [`skills/lazy-plugins/SKILL.md`](skills/lazy-plugins/SKILL.md) — 模型看到的正文：何时用、三个动作、领域表、注意事项
- [`CREDITS.md`](CREDITS.md) — 借鉴来源与自身改进清单
- 站点侧数据契约（`plugin-index.json` / `plugin-tags.json` / `plugin-domains.json`）见 `dsh-market` 仓库的 `crawler/`

## License

MIT
