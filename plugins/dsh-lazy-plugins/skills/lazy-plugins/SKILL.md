---
name: lazy-plugins
description: 需要某个能力但当前工具做不到时，先从市场找插件装上再用，而不是自己造或放弃。
whenToUse: 用户的任务需要一项当前会话没有的能力（做视频、读 PDF、连数据库、语音、导出会话…），或你要为某个功能写代码之前。
---

# 按需加载市场插件

市场的插件有 1.5 万条，能覆盖的能力远多于常驻工具。**先查市场，再动手写**——一个装得上的插件通常比自己写代码更快、更稳。

## 什么时候用

- 任务需要的能力当前工具集里没有（视频/PDF/数据库/语音/通知/导出/可视化…）；
- 你要为某个功能写代码前（先确认没有现成插件）；
- 已装的插件不够用，需要换一个更合适的。

## 三个动作就够

| 动作 | 一句话 | 说明 |
|---|---|---|
| `ensure` | `ensure { need: "一句话需求" }` | 自动挑最匹配的并**直接安装**；判定不明确时返回候选清单 |
| `load` | `load { name }` | 装指定包（已装则只启用）。默认 `activate: proxy`：插件生效，但它的工具**不进你的工具列表**，避免打碎提示词缓存 |
| `invoke` | `invoke { tool, arguments }` | 调用被隐藏的工具；`load` 的返回里有 `proxied` 工具名和 `callWith: "invoke"` |

**装完就留着**：按需装上的插件默认不删——在 proxy 模式下它不占提示词空间，随时还能 `invoke`。
只有用户明确要求、或确实长期不用时，才 `release { name }`（卸载并清出自动池）。
`list` 看现状；`advise` 看工具面成本、缓存命中与「自动池里 30 天没用」的提示（只是提示，不会自动删）。

## 判定规则（实测校准）

- `ensure` 只在「分数 ≥ 40」且「领先第二名 1.5×」时才自动装（精度 0.90）；
- 否则回候选，由你或用户挑——这是更便宜的错误；
- `load` 回 `installable: false` 就是任何 registry 都装不上，**换候选，别重试**。

## 示例

```
ensure { need: "做一个竖版宣传片，需要脚本、分镜、成片" }
→ pick: dsh-brewreel（85.85 分、2.8× 领先）→ 自动安装 → invoke 它的工具

load { name: "dsh-context" }        # 上下文仪表盘
invoke { tool: "todo_today" }       # 调用被隐藏的工具
// 通常不需要 release：proxy 模式下常驻不占提示词空间
```


## 应用更新之后（必做）

DSH 升级会按各插件的 `engines.dsh` 重新裁决，**不匹配的插件会被静默拒绝**（实例：2026-11-08 升到 0.2.2-rc.1 后 `dsh-ops@0.4.4` 被拒，所有 `ops_*` 工具消失）。

升级后先跑一次只读体检：

```
lazy_plugin { action: "verify" }
→ runtime: { version, source: "asar" }
→ incompatible: [ { name, installed, enginesDsh, fix } ]   // 空数组 = 全兼容
→ orphans / dangling: 半装残留与悬空链接
→ verdict: "ok" | "action-needed"
```

有 `incompatible` 时的处置顺序：

1. **升级到匹配版本**（首选，无需风险确认）：`load { name: "dsh-ops", version: "0.5.0" }`——版本号从 npm 查最新，看它的 `engines.dsh` 是否覆盖当前运行时；
2. 没有可用版本时，才考虑 `plugin_manager set_version_exemption`（会明确提示崩溃/数据损坏风险，需用户点头）；
3. 都不行就 `release` 掉，等作者适配。

其它防线（插件内置，无需配置）：profile 写操作串行化（同一时刻只有一个安装/卸载在跑）；安装结果不是 `applied`/`restart-required` 时自动回滚，不留半装；git 源走归档 tarball 安装，不产生 `link:` 悬空行。


## 觉得慢先看数据

`advise` 里有 `perf`：最近 300 次动作的分段耗时（每个动作的 p50/p95/max + 最慢 5 次）。单次响应的 `ms` 是总耗时；`suggest`/`ensure` 另带 `enrichMs` 与 `enrichPhases`（站点索引/描述表/网络），`load` 带 `phases`（lookup/probe/install）。

判断口径：`suggest` 正常 <300 ms，`load` 的 `install` 基本就是 pnpm（1.5–3 s），`probe` 正常 <200 ms。若 `enrichMs` 涨到秒级，说明站点索引映射在重建——它已改为后台刷新，不应阻塞。


## 更新与「纳入按需」（v3.31+）

**查可更新**（只读，并行查 7 个依赖约 3 s）：

```
lazy_plugin { action: "outdated" }
→ outdated: [ { name, installed, latest } ]      # 已过滤 deprecate / 非 bundle / 与本运行时 engines 不兼容 / 预发布
```

**执行更新**（走官方 `updateBundle`：换版前校验存在性+engines，HMR 下先卸旧版，装失败自动装回）：

```
lazy_plugin { action: "update", name: "dsh-context" }     # 单个
lazy_plugin { action: "update", all: true }                # 全部可更新项
```

**把已装插件纳入按需**（工具不再进你的工具列表，省常驻 token；可通过 invoke 调用）：

```
lazy_plugin { action: "adopt", name: "dsh-ops" }          # 关一次再开一次，用差异算出它拥有哪些工具，然后屏蔽
lazy_plugin { action: "unadopt", tools: ["a","b"] }      # 恢复可见（省略 tools = 全部恢复）
```

实测：`dsh-ops` 拥有 17 个工具 ≈ 4,909 tokens/轮；`@goodandready/dsh-context-lens` 2 个工具 ≈ 516 tokens。

**注意**：`adopt` 会切换一次 bundle（约 0.5-1 s，且会重建一次提示词前缀）；对提供 `ops_bash` 这类关键工具的包，先确认自己能通过 `invoke` 调它。


## 常见领域 → 现成插件（v3.40）

不确定该找什么时先用 `recipes`（本地文件，0 网络，2 ms）：

```
lazy_plugin { action: "recipes" }              # 全部 18 个领域
lazy_plugin { action: "recipes", domain: "voice" }
```

| 领域 | 说明 | 领域 | 说明 |
|---|---|---|---|
| video | 视频剪辑 / 宣传片 / 短视频 | db | 数据库 / SQL |
| copywriting | 文案 / 写作 / 标题 | crawl | 爬虫 / 网页抓取 |
| image | 图像生成 / 修图 / 设计 | deploy | 部署 / 运维 / 服务器 |
| voice | 语音合成 / 朗读 / 语音输入 | test | 测试 / 代码质量 |
| pdf | PDF / 文档读取 | notes | 笔记 / 知识库 |
| sheet | 表格 / 数据分析 | notify | 通知 / 消息推送 |
| translate | 翻译 / 多语言 | chart | 图表 / 可视化 |
| session | 会话导出 / 总结 | browser | 浏览器 / 自动化 |
| context | 上下文管理 / 压缩 | skill | 技能 / 提示词模板 |

**这些名字是怎么验证的**：格式 1 索引里有这行 → install-facts 没判它不可安装 → `engines.dsh` 接受当前运行时 → 名字按分隔符切词后命中该领域（描述关键词不算证据，目录里的描述被截断到约 40 字）。**不按 star/download 排序**——社区 registry 的这两个字段实测是伪造量级（`dsh-our-free-model` 报 64,573 stars）。生成脚本与过滤统计见 `data/domains.json` 的 `method`/`filters` 字段。

领域条目只是**先验**：命中的候选在 `suggest` 里乘 1.12，不改变决定性判定；决定能否自动装的仍是分数 ≥40 且领先 1.5×。

## 注意

- 一次只装一个；装完留着，别为了“干净”去删。
- `git` 源的大仓库走「并发镜像 + 归档安装」，通常 10–20 s；索引里有约一半条目是装不上的幽灵条目，`load` 会先探测再决定。
- 常驻（`resident`）与 base bundle 有保护，`release` 不会误删。
