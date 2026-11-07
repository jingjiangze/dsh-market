# 借鉴来源与改动说明（v2.0.0）

本插件不是凭空设计，各能力面分别借鉴了市场里已被验证的做法。下表列出出处与具体借用点，便于回溯与上游跟进。

| 借鉴点 | 出处（包名 / 版本） | 借用内容 | 我们的差异 |
|---|---|---|---|
| 默认休眠、召唤即注册、释放即注销 | `dsh-mcp-summon` 0.1.0 | `release` 的语义与命名：不用时不留驻 | 对象是 npm 插件包（bundle），不是 MCP 服务器；走 `pluginManager` 而非 MCP 客户端注册 |
| 运行时热重启插件，无需重启 dsh | `dsh-hotswap` 0.1.1 | `reload` 动作：停用→启用，使新版本模块生效 | hotswap 走 Loader 层只热挂载已装包；我们额外具备从市场解析并安装的能力 |
| 会话内热重载 | `dsh-skill-mcp-manager` 1.2.2 | 同一会话内生效、无需重开会话 | 对象是插件包 |
| 像 Skill 一样按需加载工具，减少上下文占用 | `dsh-tool-manager` 1.2.11 | `deferLoading` 配置项：工具 schema 默认不进初始上下文 | 默认关闭（单个工具 schema 很小，且需要模型能主动发现它） |
| 已装状态的读取与展示口径 | `dsh-plugin`(hub) 2.3.4、`@ace-zone/dsh-market` 0.1.67、`dsh-open-market` 0.3.3 | `pluginManager.listBundles()` 的读取方式与行 id 展示 | 这些是人工点击的 Settings UI；我们是模型可调用的 agent 工具 |
| 缓存优先 + 并发共享一次读取 | `dsh-open-market` 0.3.3（`Promise.race([readCache, sleep(1500)])`） | 「先给缓存、同时在后台刷新」的范式 | 我们加了条件请求（304 零字节）与磁盘副本，跨进程生效 |
| 顺序镜像链 | `@ace-zone/dsh-market` 0.1.67（`@main/site/` → raw，`REGISTRY_TIMEOUT_MS=8000`） | 多源顺序回退的思路 | 镜像清单按本机实测重排（raw 不可达、gcore 过慢已剔除） |
| 硬保护只给宿主自身 | `dsh-hotswap` 0.1.1（`DEFAULT_PROTECTED` 15 项 = webserver/typert/hmr 等；`index.js:672` 抛错无 force） | 「结构性不能删」的对象是 base bundle，不是常用插件 | 保护范围收窄到 `availability !== 'profile'` 且启用的 bundle；常用插件只做提示不阻断 |
| 「常用」用时间衰减而不是总次数 | Debian popcon（判常用看 atime）；Firefox MV3 的 `persistent` 已从默认 true 变为非法 | 常驻是例外，默认不常驻；最近使用 > 历史累计 | 14 天半衰期 + 阈值 3，纯本地计数，不联网 |
| 失败不落脏状态 | `dsh-hotswap:684`「Runtime first: a failed unload/load must not be persisted」 | 停用/启用失败不许留下不可用状态 | `reload` 失败自动重试一次并回传 diagnostic；base bundle 直接拒绝

## 已评估但未采纳

- **安装证据上报到站点**（曾考虑借鉴 `dsh-plugin-scout` 0.1.11 的核验思路）：用户明确表示不需要。
  因此本插件**不做任何上报，不联网发送任何数据**，只与市场索引和 profile 的插件管理服务交互。
  v1.1.1 已把 v1.1.0 里的 report/token/dryRun 相关代码全部移除。
- `@dsh-external/dsh-plugin-toggle`（git 源 v0.2.1）：只对已安装插件做免重启启停，
  与 `pluginManager.setBundleEnabled` 能力重叠，不另做适配层。
- `dsh-tool-guardian` 0.10.0-beta.1 的输出压缩/归档：与本插件目标无关。

## 自身改进（无对应上游，来自对索引与本机的实测）

| 改进 | 起因（实测） |
|---|---|
| 装前可用性探测：下载前先并行 HEAD 各 registry 的 `<name>/<version>`，全 404 就直接回 `installable:false` | 抽样 80 条索引条目，48 条在任何公共 registry 上都不存在；原先要等 pnpm 跑完几十秒才报 `ERR_PNPM_FETCH_404`（实测 2.6–3.5 s） |
| 分层预算：首字节 3 s、正文 20 s、快探 400 ms、全扫 6 s | 实测主源 0.5 s/1.43 s、jsDelivr 3.92 s；把 5 s 当「含正文」的截止时间会掐死健康镜像 |
| 别名还原：索引把重名条目改成 `dsh-voice-8`，真实包名只在 `title` 里；把 `title` 作第二候选，探测通过才用 | `dsh-voice-8` 直装必然 404，改用 `dsh-voice@0.4.2` 后装载成功 |
| 索引磁盘缓存 + 条件请求热更新 + 失败保留旧副本（有意背离上游「失败不留文档」） | 冷读 1.4 s、磁盘命中 42 ms、304 刷新 482 ms / 0 字节；断网时旧副本仍可用 |
| 三条刷新触发：启动 / 面板 `GET /lazy-plugins/refresh`（节流 60 s）/ 每天保底 | 用户要求「上线一次 + 进面板一次 + 每天保底一次」 |
| 常驻判定改为计算式：`base`（结构性保护）∪ `explicit` ∪ `auto`（使用分 ≥3，14 天半衰期），并取消工具侧 `force` 参数 | 用户质疑「常驻守卫有利有弊、应先有公式」；审计确认 9 个同类插件里只有 hotswap 有保护概念，且只保护宿主自身 |
| `reload` 失败自动重试 + 回传 diagnostic + 修复提示 | 实测一次 reload 因 `cordis.patch.yml` 里 `@scope` 未加引号而停在停用态、工具被注销 |
| `load` 快路径：已装则直接启用，不走索引与探测 | 实测 144 ms；冷装小包 2,550 ms（lookup 98 / probe 26 / install 2,325） |
| `ensure`：任务句 → 候选 → 判定明确时自动装，判定用「绝对分 + 领先幅度」双门槛 | 31 条需求语料实测：`40/1.3` 精度仅 0.636（11 次装错 4 次）；收紧到 `40/1.5` 后 0.80 |
| 分类**软加权**（同 top1 分类 ×1.3），不做过滤、不做 tie-break | 实测：加权 P 不变 0.800、覆盖 0.167→0.333；过滤掉到 0.733；tie-break 全语料零触发。打乱标签的对照掉 0.203，证明是真信号 |
| 双语桥接：15 组能力词（语音↔voice/tts、数据库↔database/sql…），桥接词权重 0.4 | 修「中文查询打不到英文描述」：`dsh-database` 曾输给中文医疗知识图谱。0.4 这档 P 0.900 / top5 召回 0.900（0.6/0.8 各放行一次误装） |
| 词表分组匹配改为「短词精确、长词才允许包含」 | CJK 二元组「数据」曾把整组「数据库」拉进任何数据类需求，导致「数据可视化」误装数据库插件（#18 回归） |
| 纯函数抽到 `lib/ranking.mjs`（分词、桥接、去重、同族判定） | `index.js` 涨到 2,245 行且打分逻辑一周内改了 5 次；抽出后 index.js 减 101 行，打分改动只碰一个文件 |
| `list` 自报 `pluginVersion` 与索引缓存状态（url/age/etag/source/超时） | 本地 `link:` 安装只有重载后才换代码，需要能区分「当前跑的是哪个版本」 |

## 数据边界

插件只做三件事：读市场索引、调 profile 的插件管理服务、返回结果。
不写日志文件、不上报、不采集会话内容或本机路径。
