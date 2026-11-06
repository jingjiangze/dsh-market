# dsh-market 流程审计（2026-11-06）

## 当前真实链路

`crawl.yml`：三分片采集 → 合并目录 → 2BingLing 适配 → 元数据补全 → Git 来源固定 → 翻译 → 多语言索引/浏览分片/资源生成 → ModelScope 上传 → 校验 → Git Data API 写入 `main` → 显式派发部署。

`translate.yml`：读取仓库中的 `dist/index.json` → 增量翻译 → 重建语言索引 → ModelScope 上传 → Git Data API 写入 `main`。

`deploy.yml`：GitHub Pages 为主发布；Cloudflare Pages 为品牌域镜像（允许失败）；部署后目前只强校验 GitHub Pages。 `sync-check.yml` 定时核对订阅端数据并在漂移时重派部署。

## 已执行

- `crawl` 与 `translate` 共用 `catalog-publish` 并发组，避免两个写入工作流同时从旧 main 建树，互相覆盖或产生非快进更新失败。
- 在 crawl 写入 main 前执行页面语法检查、页面冒烟、在线格式/registry 校验和受限 dry-run；不能再把 push 后的 CI 当作发布前门禁。
- README 已修正为当前真实的 Git Data API 直写流程，不再描述已经不存在的 crawl PR 流程。
- 移除 crawl 工作流不再需要的 pull-request 写权限。

## 仍需处理

1. `publish-api.mjs` 在更新 ref 遇到外部并发写入时没有完整的重新读取、重建树和有限重试。工作流互斥降低了内部竞态，但不能防止人工 push 或其他自动化写 main。后续应实现带 expected head 的 CAS 重试，或改成单一发布工作流。
2. Cloudflare Pages 当前 `continue-on-error`，且部署后校验只覆盖 GitHub Pages。建议将 CF 定义为明确的 best-effort 镜像，并增加独立状态检查；不要让次级镜像故障阻断主索引。
3. `data/`、`dist/`、`site/` 混合了缓存、源数据和生成物；仓库树中仍有大型缓存/历史构建文件。应建立清晰的保留策略：只提交可复现所必需的状态，临时缓存走 Actions cache/artifact，发布物走 Pages/数据集。
4. 索引当前没有签名，安装侧仍需以包源和实际版本二次校验；本仓库的格式门禁不等于插件代码安全审计。

## 建议目标结构

- **输入层**：可追溯的来源适配器，保存来源版本/抓取时间/内容摘要。
- **规范化层**：统一 schema、去重、兼容性与许可门禁，拒绝原因结构化留档。
- **发布层**：唯一写入者构建不可变 release manifest，完成校验后原子更新 current 指针。
- **分发层**：GitHub Pages 主源、Cloudflare 镜像、数据集资源分开验证；消费者只读取版本化产物。
- **状态层**：缓存与运行状态独立于发布索引，避免大文件持续污染 Git 历史。
