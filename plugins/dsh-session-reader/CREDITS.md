# 借鉴来源与改动说明（v1.0.0）

本插件的判断与实现方式来自对市场里 51 个「会话类」插件的代码级审计（报告：
`_tmp/session-audit-session-plugin-audit/REPORT.md`）。下表只列**实际借鉴**的点，便于回溯。

| 借鉴点 | 出处（包名 / 版本） | 借用内容 | 我们的差异 |
|---|---|---|---|
| 读**完整日志**而不是模型面 | `dsh-archive-viewer` 1.1.5（`docs/INTERNALS.md:44`） | 「宿主用 `sessionQuery.readSession()` 读完整日志折行，而不是 `readSurface()`」——compaction 会把旧事件替换成 `compaction/summary`，surface 上的原文会消失 | 我们把它固化成 `read` 动作的唯一读法，并在代码注释里写明理由 |
| 不依赖官方 FTS5 索引 | `dsh-session-history-search` 0.1.0（`index.js:13`） | 官方索引 `unicode61` 分词器不切连续 CJK，中文全文检索会漏 | 改为 JS 侧**字面子串**匹配（中文天然正确，ASCII 大小写不敏感），与磁盘回退共用同一条代码路径 |
| 索引不可用时的降级 | `dsh-session-search-bar` 1.0.0（`cordis.patch.yml:4`） | 「默认 `ctx.sessionQuery` 用 `openAt: never`，无法全文搜索」 | 我们不建索引（只读、无副作用），改为按需读取 + 60 秒内存缓存 |
| 可见会话的过滤口径 | `dsh-session-search-bar` 1.0.0（`index.js:473`） | 无 `cwd` 的匿名会话与 `origin==='subagent'` 的子代理会话与侧栏语义不同 | 我们**不隐藏**，而是在 `list` 结果里如实给出 `origin`/`parent`/`cwd`，由调用方判断 |
| 工具 schema 极简 + 结果字节上限 | `dsh-lazy-plugins` 1.3.1（同工作区） | `clean()` 无损 JSON、单次结果字节预算、`output.render` 约定 | 追加 `truncated` + `nextCursor`（`offset:N`）分页 |
| 磁盘会话日志的多帧 zstd 解码 | 实测（本机 `~/.dsh/sessions/**/session.v4.jsonl.zstd`） | 该文件是**多帧拼接**的 zstd（74 帧 / 727578 B / 126 事件），`zstd -d` 只吐出第一条记录 | 按魔数 `28 b5 2f fd` 逐帧贪心解压 |

## 明确未采用的做法

- **自建索引**（`dsh-session-workbench` 把 SQLite 索引写到 `~/.dsh/session-query.sqlite`）：会写磁盘、留残留，与「只读」目标冲突。
- **自爬会话目录绕过服务**（`dsh-session-search` 0.1.1、`@1agents/session-reader`）：绕过 `sessionQuery` 等于绕过其作用域/授权判断；我们只在**服务不可用**时才走磁盘，且只读。
- **`readSurface()`**（`dsh-cross-session-ref` 0.2.1 的做法）：被压缩的历史内容会丢。

## 无遥测

没有任何上报、埋点或网络请求。
