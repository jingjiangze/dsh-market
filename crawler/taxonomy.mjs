// Taxonomy v3 — rebuilt from the vocabularies the other catalogs actually use.
//
// Inputs measured on 2026-11-06:
//   dsh-plugin-catalog (official curated, 4.7k): 23 classes, balanced (largest 19%)
//   dsh.so (11k): 10 classes, 1,011 entries unlabelled
//   awesome-dsh-plugin-feed: 10 classes, 100 per bucket (hand-paginated)
//   2BingLing (18k): EVERY entry carries Chinese semantic tags — 12,282 distinct,
//     e.g. 效率提升 7999, 工具集成 5393, ai 助手 4541, 会话管理 3866, 状态监控 3653,
//     零配置 3187, 可视化 2844, 工作流增强 2804, 前端增强 2703, 插件管理 2588,
//     模型配置 2372, 状态持久化 2078, 设置面板 1959, 界面美化 1856, 安全审查 1597,
//     多智能体协作 1409, 数据分析 1232, 成本控制 1154, 消息通知 1041, 视觉理解 873
//
// v1 had 14 flat leaves and put 8.2% in `other`; v2 used the official 23 but still
// leaned on keyword luck. v3 keeps the DSH-first rail the page renders, and decides
// membership in this order:
//   1. the entry's own tags (far richer than a single category)
//   2. the source's category, mapped per source (the same word means different things)
//   3. keyword rules over name/title/description
//   4. `other`
const RAILS = {
  enhance: { en: 'DSH itself', zh: 'DSH 优化' },
  agent: { en: 'Agents & workflow', zh: '智能体与工作流' },
  content: { en: 'Content & data', zh: '内容与数据' },
  connect: { en: 'Connections', zh: '连接与集成' },
  dev: { en: 'Development & ops', zh: '开发与运维' },
  eco: { en: 'Ecosystem', zh: '生态与资源' },
}

const CATEGORIES = {
  // ── A. 直接改造 DSH 本体 ────────────────────────────────────────────────
  'enhance-ui': { en: 'Interface & themes', zh: '界面与主题' },
  'enhance-session': { en: 'Sessions & messages', zh: '会话与消息' },
  'enhance-models': { en: 'Models & providers', zh: '模型与供应商' },
  'enhance-usage': { en: 'Usage & billing', zh: '用量与计费' },
  'enhance-tools': { en: 'Tools & CLI', zh: '工具链与 CLI' },
  'enhance-perf': { en: 'Performance & caching', zh: '性能与缓存' },
  'enhance-memory': { en: 'Memory & context', zh: '记忆与上下文' },
  'enhance-settings': { en: 'Settings & config', zh: '设置与配置' },
  // ── B. 智能体与工作流 ───────────────────────────────────────────────────
  'agent-orchestration': { en: 'Agents & orchestration', zh: '智能体与编排' },
  'agent-skills': { en: 'Skills & prompts', zh: '技能与提示词' },
  'agent-workflow': { en: 'Workflow & automation', zh: '工作流与自动化' },
  // ── C. 内容与数据 ───────────────────────────────────────────────────────
  'data-search': { en: 'Search & retrieval', zh: '搜索与检索' },
  'data-docs': { en: 'Documents & rendering', zh: '文档与渲染' },
  'data-office': { en: 'Office & writing', zh: '办公与创作' },
  'data-analysis': { en: 'Analysis & charts', zh: '数据分析与可视化' },
  'media-vision': { en: 'Vision & images', zh: '视觉与图像' },
  'media-voice': { en: 'Voice & audio', zh: '语音与音频' },
  'media-fun': { en: 'Just for fun', zh: '娱乐与彩蛋' },
  // ── D. 连接与集成 ───────────────────────────────────────────────────────
  'connect-im': { en: 'Chat & notifications', zh: '即时通讯与通知' },
  'connect-web': { en: 'Browser & web', zh: '浏览器与网页' },
  'connect-mcp': { en: 'MCP & protocols', zh: 'MCP 与协议' },
  'connect-remote': { en: 'Remote & mobile', zh: '远程与移动端' },
  'connect-wsl': { en: 'WSL & Windows', zh: 'WSL 与 Windows' },
  'connect-files': { en: 'Files & workspace', zh: '文件与工作区' },
  // ── E. 开发与运维 ───────────────────────────────────────────────────────
  'dev-git': { en: 'Git & code review', zh: 'Git 与代码评审' },
  'dev-runtime': { en: 'Development & runtime', zh: '开发与运行时' },
  'ops-security': { en: 'Security & permissions', zh: '安全与权限' },
  'ops-monitor': { en: 'Health & monitoring', zh: '状态监控与诊断' },
  // ── F. 生态与资源 ───────────────────────────────────────────────────────
  'eco-market': { en: 'Markets & managers', zh: '插件市场与管理' },
  'eco-resources': { en: 'Templates & packs', zh: '模板与合集' },
  other: { en: 'Other', zh: '其他' },
}

// Rail -> leaves, in display order. Ids keep the prefix the page folds on
// (enhance-*, agent-*, data-*/media-*, connect-*, dev-*/ops-*, eco-*).
const CATEGORY_GROUPS = {
  enhance: ['enhance-ui', 'enhance-session', 'enhance-models', 'enhance-usage', 'enhance-tools', 'enhance-perf', 'enhance-memory', 'enhance-settings'],
  agent: ['agent-orchestration', 'agent-skills', 'agent-workflow'],
  content: ['data-search', 'data-docs', 'data-office', 'data-analysis', 'media-vision', 'media-voice', 'media-fun'],
  connect: ['connect-im', 'connect-web', 'connect-mcp', 'connect-remote', 'connect-wsl', 'connect-files'],
  dev: ['dev-git', 'dev-runtime', 'ops-security', 'ops-monitor'],
  eco: ['eco-market', 'eco-resources', 'other'],
}

// ── 1. tag vocabulary (2BingLing carries these on every entry) ─────────────
// Weights track the observed corpus size, so 工具集成 (5393) outranks a rare tag.
const TAGS = {
  'enhance-ui': [['界面美化', 90], ['前端增强', 90], ['主题', 60], ['theme', 60], ['桌宠', 40], ['侧边栏', 40], ['sidebar', 40], ['动画', 30], ['皮肤', 30], ['壁纸', 30], ['启动动画', 40], ['ui', 20]],
  'enhance-session': [['会话管理', 90], ['消息管理', 70], ['会话', 50], ['聊天记录', 50], ['历史记录', 40], ['session', 40], ['消息', 30], ['导航', 20]],
  'enhance-models': [['模型配置', 90], ['模型适配', 70], ['多模型', 60], ['模型', 50], ['供应商', 50], ['provider', 40], ['openai', 30], ['claude', 30], ['gemini', 30], ['llm', 25]],
  'enhance-usage': [['成本控制', 90], ['用量统计', 70], ['额度', 40], ['计费', 40], ['usage', 40], ['billing', 40]],
  'enhance-tools': [['工具集成', 90], ['工具链', 70], ['命令行工具', 60], ['快捷操作', 60], ['cli', 40], ['快捷键', 40], ['tool', 30]],
  'enhance-perf': [['性能优化', 80], ['缓存', 60], ['加速', 60], ['性能', 50], ['cache', 40], ['perf', 40]],
  'enhance-memory': [['记忆', 80], ['上下文', 60], ['知识库', 60], ['memory', 60], ['context', 50], ['rag', 40], ['压缩', 30]],
  'enhance-settings': [['设置面板', 90], ['零配置', 70], ['配置管理', 60], ['settings', 40], ['配置', 40]],
  'agent-orchestration': [['多智能体协作', 90], ['智能体', 70], ['子代理', 60], ['编排', 60], ['multi-agent', 60], ['agent', 40], ['角色', 30]],
  'agent-skills': [['技能', 70], ['提示词', 60], ['预设', 50], ['skill', 50], ['prompt', 50], ['persona', 30]],
  'agent-workflow': [['工作流增强', 90], ['工作流', 70], ['自动化', 60], ['定时任务', 60], ['workflow', 50], ['证据链', 40], ['任务管理', 40]],
  'data-search': [['搜索', 70], ['检索', 60], ['知识检索', 50], ['联网搜索', 60], ['search', 50], ['爬取', 30]],
  'data-docs': [['文档', 60], ['渲染', 50], ['pdf', 50], ['markdown', 50], ['表格', 40], ['导出', 30]],
  'data-office': [['办公', 60], ['写作', 60], ['翻译', 50], ['邮件', 50], ['笔记', 40], ['office', 40], ['email', 40]],
  'data-analysis': [['数据分析', 90], ['可视化', 80], ['图表', 60], ['报表', 50], ['chart', 40], ['分析', 40]],
  'media-vision': [['视觉理解', 90], ['图像', 60], ['截图', 50], ['ocr', 50], ['图片', 40], ['vision', 40]],
  'media-voice': [['语音', 70], ['语音合成', 60], ['tts', 50], ['音频', 50], ['voice', 40], ['音乐', 30]],
  'media-fun': [['娱乐互动', 90], ['娱乐', 60], ['彩蛋', 50], ['游戏', 40], ['摸鱼', 40], ['fun', 30]],
  'connect-im': [['消息通知', 90], ['通知', 70], ['钉钉', 60], ['飞书', 60], ['qq', 50], ['telegram', 50], ['wechat', 50], ['notify', 40], ['webhook', 40]],
  'connect-web': [['浏览器', 70], ['网页', 60], ['browser', 50], ['playwright', 40], ['抓取', 40], ['rss', 30]],
  'connect-mcp': [['mcp', 90], ['协议', 50], ['桥接', 40], ['适配器', 40], ['adapter', 30]],
  'connect-remote': [['远程', 70], ['移动端', 60], ['内网穿透', 50], ['remote', 40], ['ssh', 30], ['tailscale', 30]],
  'connect-wsl': [['wsl', 80], ['windows', 50], ['powershell', 30]],
  'connect-files': [['文件管理', 80], ['工作区管理', 80], ['本地处理', 60], ['文件', 50], ['workspace', 40], ['目录', 30]],
  'dev-git': [['代码审查', 90], ['代码评审', 60], ['git', 70], ['github', 50], ['diff', 30]],
  'dev-runtime': [['开发者体验', 90], ['插件开发', 70], ['调试', 50], ['运行时', 40], ['typescript', 40], ['插件开发工具', 50], ['sdk', 30]],
  'ops-security': [['安全审查', 90], ['安全', 70], ['权限', 60], ['审计', 50], ['security', 50], ['脱敏', 30]],
  'ops-monitor': [['状态监控', 90], ['运行时诊断', 80], ['状态持久化', 60], ['监控', 70], ['诊断', 60], ['日志', 50], ['健康检查', 40]],
  'eco-market': [['插件管理', 90], ['插件市场', 90], ['dsh-plugin-market', 60], ['市场', 60], ['market', 40]],
  'eco-resources': [['模板', 50], ['合集', 50], ['资源', 40], ['awesome', 30]],
}

// ── 2. per-source category tables ─────────────────────────────────────────
const OFFICIAL = {
  agi: 'agent-orchestration', ui: 'enhance-ui', usage: 'enhance-usage', theme: 'enhance-ui',
  model: 'enhance-models', identity: 'connect-im', session: 'enhance-session', memory: 'enhance-memory',
  tools: 'enhance-tools', wsl: 'connect-wsl', browser: 'connect-web', vision: 'media-vision',
  voice: 'media-voice', docs: 'data-docs', skill: 'agent-skills', workflow: 'agent-workflow',
  git: 'dev-git', notify: 'connect-im', dev: 'dev-runtime', security: 'ops-security',
  remote: 'connect-remote', market: 'eco-market', fun: 'media-fun',
}
const DSH_SO = {
  agents: 'agent-orchestration', creator: 'data-office', dev: 'dev-runtime', memory: 'enhance-memory',
  notify: 'connect-im', office: 'data-office', search: 'data-search', skin: 'enhance-ui',
  tools: 'enhance-tools', vision: 'media-vision',
}
const AWESOME = {
  'agents-workflows': 'agent-workflow', 'multi-agents': 'agent-orchestration',
  'knowledge-research': 'enhance-memory', 'developer-tools': 'dev-runtime',
  'ui-experience': 'enhance-ui', 'media-vision': 'media-vision',
  'web-browser': 'connect-web', 'integrations-sharing': 'connect-mcp',
  utilities: 'enhance-tools', 'ecosystem-resources': 'eco-resources',
}
const MYDSH = { 界面与主题: 'enhance-ui', 启动动画: 'enhance-ui', 技能: 'agent-skills', MCP: 'connect-mcp', 场景: 'agent-orchestration', 提示词: 'agent-skills' }

const SOURCE_TABLES = {
  'src-dshso': DSH_SO,
  'src-awesome': AWESOME,
  'src-mydsh': MYDSH,
  'src-polang': OFFICIAL,
  'src-official': OFFICIAL,
}

// ── 3. keyword rules over the free text, most specific first ──────────────
// CJK has no word boundary in JS regex, so Chinese alternatives are never wrapped
// in \b — `\b核对\b` silently never matched, and that alone put hundreds of
// compliance plugins into `other`.
const RULES = [
  ['eco-market', /\b(plugin[- ]?market|marketplace|plugin[- ]?manager|plugin[- ]?hub|catalog|index[- ]of|registry)\b|插件市场|插件管理/],
  ['ops-security', /\b(audit|security|secret|secrets|guard|quarantine|permission|sandbox|vet|allowlist|oauth|vault|credential|redact)\b|安全|权限|审批|脱敏/],
  ['enhance-usage', /\b(usage|billing|quota|cost|spend|rate[- ]?limit|leaderboard)\b|用量|计费|额度|成本/],
  ['enhance-models', /\b(provider|providers|llm|api[- ]?key|openai|anthropic|claude|gemini|qoder|codex|subscription|free[- ]?model)\b|模型|供应商|账号接入/],
  ['media-voice', /\b(tts|voice|audio|speech|music|sound|podcast|whisper|asr)\b|语音|音频/],
  ['media-vision', /\b(image|images|video|screenshot|vision|ocr|chart|canvas|blender|poster|genui|wallpaper|avatar|skin|pet)\b|视觉|图像|壁纸|皮肤/],
  ['data-docs', /\b(pdf|docx|xlsx|ppt|slides|markdown|notion|latex|mermaid|diagram|export|render)\b|文档|渲染/],
  ['data-analysis', /\b(analytics|analysis|dashboard|metric|metrics|report|visuali[sz])\b|数据分析|可视化|报表/],
  ['data-office', /\b(office|blog|post|copyright|translate|novel|writing|email|mail|calendar|todo|note|notes)\b|办公|创作|翻译|邮件|日程|小说/],
  ['connect-im', /\b(feishu|lark|qq|telegram|discord|wechat|weixin|slack|dingtalk|bark|notify|notification|push|webhook)\b|通知|钉钉|飞书|消息推送|即时通讯/],
  ['connect-web', /\b(browser|chrome|playwright|puppeteer|cdp|webpage|scrape|scraper|crawler|rss|feed)\b|浏览器|网页|爬虫/],
  ['connect-remote', /\b(remote|mobile|tailscale|lan[- ]?proxy|ssh|tunnel|vpn|vps|relay)\b|远程|移动端|内网穿透/],
  ['connect-wsl', /\b(wsl|windows[- ]?interop|win32)\b|互操作/],
  ['connect-mcp', /\b(mcp|bridge|gateway|adapter|connector|integration|integrations|protocol)\b|集成|桥接|协议/],
  ['connect-files', /\b(file|files|workspace|directory|folder|attachment)\b|文件|工作区|本地/],
  ['dev-git', /\b(git|github|worktree|commit[- ]?graph|code[- ]?review|pull[- ]?request)\b|代码评审|代码审查/],
  ['dev-runtime', /\b(dev|debug|lint|ide|editor|typescript|runtime|pnpm|npm|build|test|sdk|framework|cli|terminal|shell|toolkit)\b|开发|运行时|调试/],
  ['ops-monitor', /\b(monitor|observ|health|diagnos|metrics?|logs?|status)\b|监控|诊断|日志|状态/],
  ['agent-workflow', /\b(workflow|automation|scheduled|cron|subagent|ralph|kanban|pipeline|orchestrat|checklist)\b|工作流|自动化|定时|核对|预检|自洽|符合性|台账|要素齐备/],
  ['agent-skills', /\b(skill|skills|prompt|prompts|preset|persona|agent[- ]?team|swarm)\b|技能|提示词|预设/],
  ['agent-orchestration', /\b(agent|agents|multi-agent|agency|summonable)\b|智能体|编排|可召唤/],
  ['enhance-session', /\b(session|message|messages|conversation|thread|chat[- ]?ui|history|navbar|annotation|sidebar|panel|badge|font|layout)\b|会话|消息|历史|导航/],
  ['enhance-settings', /\b(setting|settings|config|configure|preferences|options)\b|设置|配置/],
  ['enhance-memory', /\b(memory|knowledge|rag|recall|embedding|obsidian|archive|context|compress|compact|summar|token[- ]?budget|prune)\b|记忆|知识|上下文/],
  ['data-search', /\b(search|retrieval|query|fulltext|database|dataset)\b|搜索|检索/],
  ['enhance-perf', /\b(cache|caching|fast|faster|speed|latency|bench|benchmark|optimiz|accelerat)\b|缓存|加速|性能/],
  ['media-fun', /\b(fun|meme|game|joke|easter[- ]?egg|cat|fish|pet|washer)\b|娱乐|彩蛋|摸鱼/],
  ['eco-resources', /\b(template|starter|boilerplate|gallery|awesome|collection|bundle|pack)\b|模板|合集/],
  ['enhance-ui', /\b(theme|themes|skin|appearance|layout|locale|localization|i18n|restart|dock|button|widget|harmoniz)\b|界面|主题|美化|侧边栏|语言包/],
  ['enhance-tools', /\b(tool|tools|utility|utilities|converter|formatter|clipboard|shortcut|command)\b|工具|快捷键/],
]

const TAG_INDEX = new Map()
for (const [leaf, entries] of Object.entries(TAGS)) {
  for (const [tag, weight] of entries) {
    const key = String(tag).toLowerCase()
    if (!TAG_INDEX.has(key)) TAG_INDEX.set(key, [])
    TAG_INDEX.get(key).push([leaf, weight])
  }
}

// Score the entry's own tags. Weights decide ties, so a plugin tagged both
// 界面美化 and 设置面板 still lands deterministically.
function fromTags(tags) {
  if (!Array.isArray(tags) || !tags.length) return null
  const score = new Map()
  for (const raw of tags) {
    const hits = TAG_INDEX.get(String(raw).toLowerCase().trim())
    if (!hits) continue
    for (const [leaf, weight] of hits) score.set(leaf, (score.get(leaf) ?? 0) + weight)
  }
  if (!score.size) return null
  return [...score].sort((a, b) => b[1] - a[1])[0][0]
}

function classifyText(...texts) {
  const haystack = texts.filter(Boolean).join(' ').toLowerCase()
  for (const [leaf, pattern] of RULES) if (pattern.test(haystack)) return leaf
  return null
}

export function categoryFor(record, ...texts) {
  // 1. the entry's own tags (2BingLing ships them on every entry)
  const tagged = fromTags(record?.hintTags)
  if (tagged) return tagged
  // 2. the source's category, resolved with that source's own vocabulary
  const hint = record?.hintCategory
  if (hint) {
    const table = SOURCE_TABLES[record?.hintSource]
    const mapped = table ? table[hint] : undefined
    if (mapped) return mapped
    if (CATEGORIES[hint]) return hint
  }
  // 3. free text
  return classifyText(...texts) ?? 'other'
}

export function classifyDomain(...texts) {
  return classifyText(...texts) ?? 'other'
}

export { CATEGORIES, CATEGORY_GROUPS, RAILS }
