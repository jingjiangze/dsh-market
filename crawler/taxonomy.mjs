// Taxonomy v2 — rebuilt after auditing the other public catalogs.
//
// Evidence (2026-11-05, live API reads):
//   dsh-plugin-catalog (official curated, 4569 entries): 23 categories, largest is
//     `ui` at 19% — fine-grained enough that almost nothing lands in "other".
//   dsh.so (10 categories): 1011/10973 entries have NO category at all.
//   awesome-dsh-plugin-feed (10 categories): exactly 100 entries per bucket.
//   our v1 (14 categories): `other` held 899/10995 (8.2%) and `enhance-perf` only 8.
//     Samples from `other` were clearly classifiable (dsh-dingtalk, dsh-email,
//     @ace-zone/dsh-market, dsh-cuigengji-plugin ...) — so the problem was the
//     keyword table, not the data.
//
// Design: 26 leaf categories declared in five rails. `enhance-*` keeps the
// "strengthens DSH itself" rail the page renders as 「DSH 优化」, but membership is
// now decided by an explicit domain map, not by whichever regex matched first.
const CATEGORIES = {
  // ── DSH 优化：给 DSH 本体加能力 ────────────────────────────────────────
  'enhance-models': { en: 'Models & providers', zh: '模型与供应商' },
  'enhance-usage': { en: 'Usage & billing', zh: '用量与计费' },
  'enhance-memory': { en: 'Memory & knowledge', zh: '记忆与知识' },
  'enhance-session': { en: 'Sessions & messages', zh: '会话与消息' },
  'enhance-ui': { en: 'Interface & themes', zh: '界面与主题' },
  'enhance-tools': { en: 'Tools & CLI', zh: '工具链与 CLI' },
  'enhance-perf': { en: 'Performance & caching', zh: '性能与缓存' },
  // ── 智能体与工作流 ───────────────────────────────────────────────────
  'agent-orchestration': { en: 'Agents & orchestration', zh: '智能体与编排' },
  'agent-skills': { en: 'Skills & prompts', zh: '技能与提示词' },
  'agent-workflow': { en: 'Workflow & automation', zh: '工作流与自动化' },
  // ── 内容与数据 ───────────────────────────────────────────────────────
  'data-search': { en: 'Search & retrieval', zh: '搜索与检索' },
  'data-docs': { en: 'Documents & rendering', zh: '文档与渲染' },
  'data-office': { en: 'Office & content', zh: '办公与创作' },
  'media-vision': { en: 'Vision & images', zh: '视觉与图像' },
  'media-voice': { en: 'Voice & audio', zh: '语音与音频' },
  'media-fun': { en: 'Just for fun', zh: '娱乐与彩蛋' },
  // ── 连接与运行环境 ───────────────────────────────────────────────────
  'connect-im': { en: 'Chat & notifications', zh: '即时通讯与通知' },
  'connect-web': { en: 'Browser & web', zh: '浏览器与网页' },
  'connect-remote': { en: 'Remote & mobile', zh: '远程与移动端' },
  'connect-wsl': { en: 'WSL & Windows', zh: 'WSL 与 Windows' },
  'connect-mcp': { en: 'MCP & integrations', zh: 'MCP 与集成' },
  // ── 开发与安全 / 生态 ────────────────────────────────────────────────
  'dev-git': { en: 'Git & code review', zh: 'Git 与代码评审' },
  'dev-runtime': { en: 'Development & runtime', zh: '开发与运行时' },
  'ops-security': { en: 'Security & permissions', zh: '安全与权限' },
  'eco-market': { en: 'Markets & managers', zh: '插件市场与管理' },
  'eco-resources': { en: 'Ecosystem & resources', zh: '生态与资源' },
  other: { en: 'Other', zh: '其他' },
}

// Page folds leaf ids into rails by prefix. Order here is the display order.
const CATEGORY_GROUPS = {
  enhance: ['enhance-models', 'enhance-usage', 'enhance-memory', 'enhance-session', 'enhance-ui', 'enhance-tools', 'enhance-perf'],
  agent: ['agent-orchestration', 'agent-skills', 'agent-workflow'],
  data: ['data-search', 'data-docs', 'data-office', 'media-vision', 'media-voice', 'media-fun'],
  connect: ['connect-im', 'connect-web', 'connect-remote', 'connect-wsl', 'connect-mcp'],
  dev: ['dev-git', 'dev-runtime', 'ops-security'],
  eco: ['eco-market', 'eco-resources', 'other'],
}

// ── dsh.so (10) ───────────────────────────────────────────────────────────
const DSH_SO = {
  agents: 'agent', creator: 'office', dev: 'runtime', memory: 'memory',
  notify: 'im', office: 'office', search: 'search', skin: 'ui',
  tools: 'tools', vision: 'vision',
}
// ── awesome-dsh-plugin-feed (10) ──────────────────────────────────────────
const AWESOME = {
  'agents-workflows': 'agent', 'multi-agents': 'agent',
  'knowledge-research': 'memory', 'developer-tools': 'runtime',
  'ui-experience': 'ui', 'media-vision': 'vision',
  'web-browser': 'web', 'integrations-sharing': 'mcp',
  utilities: 'tools', 'ecosystem-resources': 'resources',
}
// ── mydsh.xyz (Chinese labels) ────────────────────────────────────────────
const MYDSH = { 界面与主题: 'ui', 启动动画: 'ui', 技能: 'skills', MCP: 'mcp', 场景: 'agent', 提示词: 'skills' }
// ── dsh-plugin-catalog / official curated index (23) ──────────────────────
// Same words as dsh.so mean different things here (e.g. `tools` is the general
// toolchain, `dev` is dev-runtime), so they must be resolved per source, not in
// one flat table — that was a real cause of v1's misclassification.
const OFFICIAL = {
  agi: 'agent', ui: 'ui', usage: 'usage', theme: 'ui', model: 'models',
  identity: 'im', session: 'session', memory: 'memory', tools: 'tools',
  wsl: 'wsl', browser: 'web', vision: 'vision', voice: 'voice',
  docs: 'docs', skill: 'skills', workflow: 'workflow', git: 'git',
  notify: 'im', dev: 'runtime', security: 'security', remote: 'remote',
  market: 'market', fun: 'fun',
}

const SOURCE_TABLES = {
  'src-dshso': DSH_SO,
  'src-awesome': AWESOME,
  'src-mydsh': MYDSH,
  'src-polang': OFFICIAL,
  'src-official': OFFICIAL,
}

// Some hints are produced by our own adapters and already use a domain id.
const DOMAIN_TO_CATEGORY = {
  models: 'enhance-models', usage: 'enhance-usage', memory: 'enhance-memory',
  context: 'enhance-memory', session: 'enhance-session', ui: 'enhance-ui',
  tools: 'enhance-tools', perf: 'enhance-perf',
  agent: 'agent-orchestration', skills: 'agent-skills', workflow: 'agent-workflow',
  search: 'data-search', docs: 'data-docs', office: 'data-office',
  vision: 'media-vision', voice: 'media-voice', fun: 'media-fun',
  im: 'connect-im', web: 'connect-web', remote: 'connect-remote',
  wsl: 'connect-wsl', mcp: 'connect-mcp',
  git: 'dev-git', runtime: 'dev-runtime', security: 'ops-security',
  market: 'eco-market', resources: 'eco-resources', other: 'other',
}

// Ordered, specific-first. Each rule returns a DOMAIN (see DOMAIN_TO_CATEGORY),
// never a leaf id. Chinese keywords are included because several catalogs ship
// Chinese-only descriptions.
const CATEGORY_RULES = [
  ['market', /\b(plugin[- ]?market|marketplace|plugin[- ]?manager|plugin[- ]?hub|catalog|index[- ]of|awesome[- ]dsh|registry)\b|插件市场|插件管理/],
  ['security', /\b(audit|security|secret|secrets|guard|quarantine|permission|permissions|sandbox|vet|policy|approval|allowlist|oauth|pkce|encrypt|vault|credential)\b|安全|权限|审批/],
  ['usage', /\b(usage|billing|quota|cost|spend|token[- ]?usage|rate[- ]?limit|leaderboard)[- ]?/],
  ['models', /\b(provider|providers|model|models|llm|api[- ]?key|openai|anthropic|claude|gemini|qoder|codex|subscription|free[- ]?model|endpoint)\b|模型|供应商|账号接入/],
  ['voice', /\b(tts|voice|audio|speech|music|sound|podcast|whisper|asr)\b|语音|音频/],
  ['vision', /\b(image|images|video|screenshot|vision|ocr|chart|charts|canvas|blender|poster|genui|wallpaper|background|pet|avatar|skin|theme|themes)\b|视觉|图像|壁纸|主题|皮肤/],
  ['docs', /\b(pdf|docx|xlsx|ppt|slides|markdown|notion|render|rendering|latex|mermaid|diagram|export)\b|文档|渲染/],
  ['office', /\b(office|content|blog|post|copyright|translate|novel|writing|editorial|email|mail|calendar|schedule|todo|task[- ]?board|note|notes)\b|办公|创作|邮件|日程|小说/],
  ['im', /\b(feishu|lark|qq|telegram|discord|wechat|weixin|slack|dingtalk|ding|bark|notify|notification|push|webhook|im[- ]?connect|chat[- ]?bot)\b|通知|钉钉|飞书|消息推送|即时通讯/],
  ['web', /\b(browser|chrome|playwright|puppeteer|cdp|webpage|web[- ]?page|scrape|scraper|crawler|rss|feed|http[- ]?proxy)\b|浏览器|网页|爬虫/],
  ['remote', /\b(remote|mobile|tailscale|lan[- ]?proxy|ssh|tunnel|vpn|vps|cloudflare|edge[- ]?tunnel|relay)\b|远程|移动端|内网穿透/],
  ['wsl', /\b(wsl|windows[- ]?interop|powershell|win32|registry[- ]?key)\b|互操作/],
  ['mcp', /\b(mcp|bridge|gateway|adapter|connector|integration|integrations|oauth[- ]?mcp)\b|集成|桥接/],
  ['git', /\b(git|github|worktree|diff|commit[- ]?graph|code[- ]?review|pull[- ]?request|pr[- ]?review)\b|代码评审/],
  ['runtime', /\b(dev|develop|debug|lint|ide|editor|typescript|runtime|pnpm|npm|build|test|ci|sdk|framework|cli|terminal|shell|tool|tools|toolkit|utility|utilities|converter|formatter|clipboard)\b|开发|运行时/],
  ['workflow', /\b(workflow|automation|scheduled|schedule|cron|subagent|ralph|kanban|goal|checkpoint|rewind|pipeline|orchestrat)\b|工作流|自动化|定时/],
  ['skills', /\b(skill|skills|prompt|prompts|preset|persona|agent[- ]?team|swarm)\b|技能|提示词/],
  ['session', /\b(session|message|messages|chat[- ]?ui|conversation|thread|navbar|annotation|sidebar|panel|badge|font|layout)\b|会话|消息|侧栏/],
  ['memory', /\b(memory|knowledge|rag|recall|embedding|sqlite|obsidian|deepread|archive|dream|chapter|context|compress|compact|summar|token[- ]?budget|prune)\b|记忆|知识|上下文/],
  ['search', /\b(search|index|database|dataset|retrieval|query|fulltext)\b|搜索|检索/],
  ['perf', /\b(cache|caching|fast|faster|speed|latency|bench|benchmark|optimiz|accelerat)\b|缓存|加速|性能/],
  ['fun', /\b(fun|meme|game|joke|easter[- ]?egg|cat|fish|pet|washer|jar|榨菜|挂件|动画|animation|splash|桌宠)\b|娱乐|彩蛋/],
  ['resources', /\b(template|starter|boilerplate|gallery|awesome|collection|bundle|pack)\b|模板|合集/],
  // Late, broad rules: these catch the long tail that the specific rules miss.
  // Chinese terms must NOT be wrapped in \b — a CJK character has no word boundary
  // in JS regex, so `\b核对\b` never matches. Keep them in a separate alternative.
  ['workflow', /\b(check|checker|precheck|verify|verification|compliance|consistency|qc|ledger|precheck)\b|核对|预检|自洽|符合性|评级|评分|台账|导则|质控|要素齐备|期限核对|结算核对/],
  ['ui', /\b(restart|dock|button|badge|toast|widget|locale|localization|i18n|russian|dictionary|jump|harmoniz|sidebar|btn)\b|界面|设计规范|侧边栏|术语词典|统一.*界面/],
  ['runtime', /\b(download|downloader|aria2|direnv|env|environment|inject|process|launcher|standalone|detach|workspace)\b/],
  ['search', /\b(research|intelligence|fund|stock|finance|weather|quake|alert|bili|bilibili|video[- ]?pick)\b|情报|行情|基金|调研/],
  ['agent', /\b(agent|agents|agency|summonable|domain[- ]?expert|professional[- ]?roles)\b|智能体|可召唤/],
  ['mcp', /\b(reverse[- ]?proxy|proxy|openviking|connection|user[- ]?keys|config[- ]?manager)\b|反向代理/],
]

function classifyDomain(...texts) {
  const haystack = texts.filter(Boolean).join(' ').toLowerCase()
  for (const [domain, pattern] of CATEGORY_RULES) if (pattern.test(haystack)) return domain
  return 'other'
}

function categoryFor(record, ...texts) {
  const hint = record?.hintCategory
  let domain = null
  if (hint) {
    const table = SOURCE_TABLES[record?.hintSource]
    domain = table ? table[hint] : undefined
    // Unknown vocabulary: a hint that is already one of our domains/leaves still
    // carries useful information (2BingLing / GitHub discovery adapters).
    if (!domain) domain = DOMAIN_TO_CATEGORY[hint] ? hint : (CATEGORIES[hint] ? hint : undefined)
  }
  if (!domain) domain = classifyDomain(...texts)
  return DOMAIN_TO_CATEGORY[domain] ?? 'other'
}

export { CATEGORIES, CATEGORY_GROUPS, categoryFor, classifyDomain, DOMAIN_TO_CATEGORY }
