# @local/dsh-lazy-plugins

按需加载市场插件的 Host 插件（v3.14.4）。本地没有的插件，在任务需要时由 agent 从市场索引解析、安装、**当场可用**；用完可以卸载移除。
默认激活方式为 `proxy`：插件真正生效，但它的工具**不进模型可见的 tools[]**，因此不会打碎提示词前缀缓存。

## Claude 式形态（v3.14）

常驻只注入一句（152 字符 / ≈38 tokens），细节在注册的 **skill** 正文里，模型需要时才加载：

- `skills/lazy-plugins/SKILL.md`：frontmatter（name/description/whenToUse）+ 正文（何时用、三个动作、判定规则、示例、注意）；
- 插件 apply 时读文件并 `ctx.get("skills").register({ name, description, whenToUse, content, invocation, provider, source: "runtime" })`；
- 实测：工具描述 **936 → 152 字符（234 → 38 tokens）**，skill 出现在模型技能目录并能按需加载（`advise.skill = ["lazy-plugins:runtime"]`）。

## 工具（模型可见面）

只有一个工具 `lazy_plugin`：

| 动作 | 含义 |
|---|---|
| `ensure` | **给一句需求**，自动挑出最匹配的插件并在判定明确时直接安装（默认走 proxy） |
| `suggest` | 任务句 → 候选排序（IDF 加权，可翻页） |
| `search` | 关键词检索（可翻页，去重 + 隐藏装不上的条目） |
| `resolve` | 看一个包的版本、安装目标（npm / git）、兼容性 |
| `load` | 安装指定版本并激活（已装则只做启用） |
| `reload` | 停用→启用，让新版本模块生效（不重启 dsh） |
| `unload` | 停用但保留安装 |
| `release` | 停用并移除 |
| `uninstall` | 直接移除 |
| `list` | 已装清单、懒加载记录、常驻判定与使用分、索引缓存状态 |
| `refresh` | 立刻刷新索引（条件请求）并预热常驻插件 |
| `advise` | 体检：工具面 tokens、缓存命中率、使用分、隐藏工具、建议 |
| `invoke` | 调用被 proxy 隐藏的工具（`{tool, arguments}`） |

## 模型调用准则

1. **有需求先 `ensure`**：一句话描述要做什么，它负责挑；判定不明确时才回候选让人选。
2. 想自己挑就用 `suggest` / `search`，按「描述最匹配」优先，其次热度；可 `offset` 翻页。
3. **优先最新版本**：不传 `version` 就是索引默认（最新）版本。
4. **一次装一个**，用完 `release`，不要囤。
5. `load` 回 `installable:false` 说明该条目任何 registry 都装不上（索引里有这类幽灵条目），换候选，别重试同一个。
6. 没有 `force` 参数：base bundle 一律拒绝停用/移除，常用插件只提示不阻断。

## 激活方式与提示词缓存

工具是 API 独立字段 `tools[]`、按名字排序，缓存断点在最后一个工具，所以**可见工具集一变，前缀就重建**。

| `activate` | 当场能用 | 前缀缓存 | 做法 |
|---|---|---|---|
| `proxy`（默认） | ✅ | ✅ 不变 | 插件激活，工具被 **per-agent `tools.restrict`** 藏起来，经 `invoke` 调用 |
| `now` | ✅ | ❌ 重建一次 | 工具原生进入 `tools[]` |
| `session` | ❌ | ✅ | 只安装，之后 `load` 一次启用（无下载，约 0.1–0.5 s） |

`invoke` 之所以能调用隐藏工具：`tools.execute()` 在 host 作用域执行，而 `restrict` 只作用于 agent 作用域（实测：`visibleForAgent: false` / `visibleGlobally: true` / `executeWithoutAgent: ok`）。
屏蔽落盘在 `hidden.json`，启动时重新打上；插件卸载后失效名字会自动剔除；插件异步注册的工具由 1.2 s / 3.5 s / 7 s 三次补扫兜住。

## 检索与自动选取

- **候选池**：`limit × 3`，先按相关性排序，再 `enrich`、过滤不可装、按安装目标合并近重复（`dsh-voice-7` / `dsh-voice-13` → `dsh-voice`，带 `variants`）。
- **IDF 加权**：`idf = ln(1 + N/(1+df))`，命中按 `idf × 字段权重`（name 3 / title 2 / description 2）累加，`dsh`/`plugin` 这类全库词不再决定排序。
- **自动选取守卫**：`ensure` 只在 `top ≥ autoSelectScore(40)` **且** `top ≥ 第二名 × autoSelectMargin(1.5)` 时才装，否则回 `needs-choice` + 候选；`auto:false` 只报告不装。
- **阈值是实测校准出来的**（31 条真实需求语料）：`40/1.3` 的自动安装精度只有 **0.636**（11 次装错 4 次），`40/1.5` 提升到 **0.80**（recall 0.367→0.167）；没有参数组合能到 0.90，所以默认偏保守，模型多看候选是更便宜的错误。
- **git-pinned 条目**（当前占 52.5%）判为可装、不走 npm 探测；`source` 字段直接回 `npm` / `git`。

## 常驻（resident）怎么算

三路来源（社区做法见 CREDITS.md）：

| 来源 | 判定 | 效果 |
|---|---|---|
| `base` | `availability !== 'profile'` 且**当前启用**的 bundle | 硬拒绝 `unload/release/uninstall` |
| `explicit` | `config.resident` | 只加提示，不阻断 |
| `auto` | `score >= residentScore(3)` | 只加提示，不阻断 |

```
score = 1.0·Σ_loads + 0.3·Σ_manualEnables + (base ? 1000 : 0)   每项 × 0.5^(Δ/14天)
```

只写本机 `~/.dsh/cache/dsh-lazy-plugins/usage.json`，不联网、不上报。

## 索引与缓存

- **拉取**：单次尝试只等首字节 3 s，失败转镜像；源顺序 = profile 索引 → `indexMirrors`。
- **缓存优先**：磁盘副本直接返回，后台条件请求热更新（304 = 0 字节）；断网时旧副本仍可用。
- **描述表**：索引自身描述覆盖率 ≥80% 时**直接投影**（零额外请求）；否则按 `descriptionSources` 拉 sidecar/旧文档。
- **刷新触发**：启动一次、**打开插件面板一次**（client 半调用 `GET /lazy-plugins/refresh?src=panel`，60 s 节流）、每天保底一次、手动 `refresh`。
- **client 半**：`client.js` + `package.json` 的 `dsh.client{platform:web,immediately:true}` + `exports['./client']`，用 `window.__ModuleLoader__.load({id, factory})` 形态（无需构建）。页面挂载即调 `GET /lazy-plugins/refresh?src=mount`，点进插件面板再调 `?src=panel`，页面侧 60 s 节流 + `sessionStorage`，失败只 `console.debug`。
- **自愈（重要，给后续维护者）**：`link:` 安装的包在**主机进程启动早于 `dsh.client` 声明**时，会被上游 `@deepseek-ai/dsh-client-modules` 的 `ClientModuleRegistry.pkgMeta` 缓存成 `null`（该缓存**没有任何失效路径**，`set_bundle false/true` 命中缓存、不够）。本插件在**启动后 `bootDelayMs` 自动一次**、以及显式 `POST /lazy-plugins/repair-client`（或 `GET /lazy-plugins/state?repair=1`）时自愈：删掉陈旧 `null` → 强制 `reconcile` 报变更 → `flush()`（内部 `compose()` + 通知）→ 图里出现本行。`GET /lazy-plugins/state` 本身**纯读、无副作用**。
- **自愈返回值**：`repair.attempted:false` + `why:"already in graph"` 是**幂等 no-op（已在图中，不是失败）**；真正的失败看 `repair.errors` 或 `repair.compose.error/failures`。
- **自愈的退出条件（必须遵守）**：这是**上游缺陷的 workaround**，不是本插件的功能。一旦 `@deepseek-ai/dsh-client-modules` 让 `pkgMeta` 的 key 带上 `package.json` 的 mtime/size、或暴露 `invalidate()`、或 `flush()` 前对 dirty 行强制重解析 —— 就**整段删除** `ensureClientRow` 及其三个触发点（启动定时器、`POST /lazy-plugins/repair-client`、`GET /state?repair=1`），此 README 对应段落一并删除。依据与建议修法见 `_tmp/panel-trigger/UPSTREAM-ISSUE.md`；`clientHalf.lastRepair.upstream` 字段也带同一句提示。
- **验证计数**：`state.panelPings`（过闸执行的刷新数）、`clientRequests`（含被节流的客户端调用）、`browserPings`（带 `Sec-Fetch-Mode`+浏览器 UA 的调用，`curl` 伪造不了）+ `lastBrowserPingFingerprint`、`lastBrowserPingSource`（`mount`/`panel`），以及 `clientHalf{inGraph,rows,graphRev,url,clientPath,lastRepair}`。
- 索引现状（2026-11-07 实测）：10,559 条、99.96% 带 zh 描述、52.5% git-pinned、166 个后缀名条目。

## 装前探测与别名

- npm 条目：并行 HEAD `<registry>/<name>/<version>`（命中 26–230 ms）；全 404 直接回 `installable:false`；超时/网络错判为未知，不挡安装。
- 别名：索引把重名条目改名成 `dsh-voice-8`，真实包名在 `title`。`load` 用 `title` 作第二候选，探测通过就装真名并回 `installedAs`。

## 可配置项

`cordis.patch.yml`（全部有默认值）：`defaultActivate`、`autoSelectScore`、`autoSelectMargin`、`autoSelectEnabled`、`resident`、`halfLifeDays`、`residentScore`、`fetchTimeoutMs`、`bodyTimeoutMs`、`refreshIntervalMs`、`dailyRefreshMs`、`panelThrottleMs`、`bootDelayMs`、`indexMirrors`、`descriptionSources`、`descriptionTtlMs`、`descriptionSearch`、`enrichDescriptions`、`enrichTimeoutMs`、`enrichRegistries`、`verifyInstall`、`probeFastMs`、`probeTimeoutMs`、`deferLoading`、`diskCache`、`cacheTtlMs`。

## 性能（本机实测）

| 场景 | 耗时 |
|---|---|
| 已装再 `load`（快路径） | 75–490 ms |
| 冷装小包（含探测+安装+激活） | 1.9–2.6 s |
| 冷装大包 / registry 抖动 | 3–5 s（个别 38 s，属上游 installBundle 抖动） |
| git-pinned 安装（`@lbxc/dsh-voice-input`） | 5.07 s |
| 索引冷拉 | ~1.0–1.7 s（gzip 约 300 KB–1 MB，随版本变化） |
| 索引 304 热更新 | 0.5–1.1 s / 0 字节 |
| 索引磁盘命中（新进程） | 42 ms |
| `search` / `suggest`（本地 10,559 条，含 IDF 扫描） | 10–30 ms |

`load` 结果带 `phases`（lookup/resolve/probe/install）与 `ms`；`advise.cache` 有命中率计数。

## 失败恢复

`reload` 是「先停用再启用」，启用失败会停在停用态 → 现在失败自动重试一次并回传 `diagnostic` + 修复提示（最常见成因：`cordis.patch.yml` 里 `@scope` 未加引号）。

## 数据边界

只做三件事：读市场索引、调 profile 的 `pluginManager`、返回结果。不写日志文件、不上报、不采集会话内容。

## 出处

见 `CREDITS.md`。
