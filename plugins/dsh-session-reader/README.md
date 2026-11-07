# @local/dsh-session-reader

读取**其他** DSH 会话：列出来、跨会话检索、把某个会话的完整对话读出来。只读，无遥测。

## 为什么需要它

官方 `@deepseek-ai/dsh-experimental-session-search` 提供 5 个工具（`session_search` / `session_event_search` /
`session_trace` / `session_event_trace` / `session_event_read`），但它们依赖 `ctx.sessionQuery` 的**抽象 FTS 方法**
（`searchSessions` / `searchEvents`），而：

1. 该 FTS 后端在默认 profile 上不可用（本机实测 `~/.dsh/session-query.sqlite` 不存在，profile 也没有 `session-query` 行）；
2. 它的 SQLite FTS5 用 `unicode61` 分词器，**不切连续中文**，中文全文检索会漏。

本插件用**字面子串**在 JS 侧匹配：中文天然正确、英文大小写不敏感，且服务路径与磁盘回退共用同一条代码路径。

## 一个工具，三个动作

| action | 做什么 | 主要参数 |
|---|---|---|
| `list` | 最近会话：短 id、标题、创建/更新时间、agentPreset、消息数、cwd、live/origin/parent | `limit`（默认 10，最大 30） |
| `search` | 跨会话字面子串检索，返回命中会话 + 前后各 60 字片段 + 事件序号 | `query`（必填）、`session`（只搜这一个）、`limit`（默认 10，最大 30） |
| `read` | 读某个会话的完整对话 | `session`（必填，支持 8 位短 id / 唯一前缀 / `session-<uuid>`）、`limit`（尾部消息数，默认 20，最大 60）、`window`、`role` |

参数共 6 个（`action` / `session` / `query` / `limit` / `window` / `role`），工具描述 370 字符。

### `window` 的两种写法

- `"120-180"` 或 `"150"` —— 按**事件序号**取窗口（`read`）。
- `"offset:N"` —— 从 `nextCursor` 续读（任何动作）。`read` 的语义是「已从最新往回看过 N 条」。

### 输出上限

单次结果序列化后 ≤ **20 000 字节**；超出时从尾部裁剪，给 `truncated: true` + `nextCursor`（`offset:N`）。
`read` 里单条消息 > 2000 字会被截断并标记 `textTruncated: true` + `fullChars`（原始字数）。

## 数据来源（按优先级，代码里同样注释）

1. **Host 服务 `sessionQuery`**（可选，用 `ctx.get('sessionQuery')` 拿，没有也能加载）：
   - `listSessions(signal?)` → `SessionRecord[]`
   - `readSession(sessionId)` → `SessionLogSnapshot{session, inheritedEventCount, events}` —— **完整原始日志**
   - `readTitleSnapshots(ids, signal?)` → 标题
   - `listEvents(sessionId)` → 轻量事件记录（用于消息数与最后活动时间）
2. **磁盘回退**：`~/.dsh/sessions/<cwd-slug>/<sessionId>/session.v4.jsonl.zstd`
   该文件是**多帧拼接的 zstd**（实测一例：74 帧 / 727 578 B / 126 事件），`zstd -d` 只会吐出第一条记录。
   本插件按魔数 `28 b5 2f fd` 逐帧贪心解压，再按行解析 `{type, seq, time, data}`。
3. 两者都不可用 → 返回 `{ unavailable: true, reason, tried }`，不抛裸错。

### 刻意不用 `readSurface()`

`readSurface()` 返回的是**模型当前视图**，compaction 会把旧事件替换成 `compaction/summary`，原文在 surface 上会消失。
只有 `readSession()`（完整日志）才拿得到被压缩掉的内容。这一判断借鉴 `dsh-archive-viewer@1.1.5` 的
`docs/INTERNALS.md:44`，见 CREDITS.md。

## 只读保证

- 只调用 `readSession` / `listSessions` / `listEvents` / `readTitleSnapshots` 这类读方法，以及 `node:fs` 的 `readFile` / `open(r)` / `readdir` / `stat`。
- 源码里没有任何 `writeFile` / `unlink` / `rename` / `mkdir` 调用（有机械测试断言，见下）。
- 没有网络调用、没有遥测、没有上报。

## 自测

机械验收（本机真实会话数据 + 服务桩）：

```bash
node _tmp/session-audit-session-plugin-audit/test-reader.mjs   # 磁盘路径 + 服务路径
node _tmp/session-audit-session-plugin-audit/test-edge.mjs     # 20KB 预算 / 截断 / 游标 / id 形态 / 无损 JSON / 无遥测
```

证据与真实返回片段：`_tmp/session-audit-session-plugin-audit/VERIFY.md`。

**PENDING**：真正装进 profile 后的端到端（真机）验证——那一步由 Lead 装载后执行；截至交付，服务路径只在镜像
`sessionQuery` 签名的桩上验证过（方法名、入参、出参形状一致，但未连真实服务）。
