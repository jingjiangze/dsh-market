// Use-case tags — the quiz's vocabulary.
//
// The corpus ships 12,282 distinct raw tags (2BingLing) plus the category words of
// four other catalogues. A quiz cannot offer 12k checkboxes, so raw tags are folded
// into a fixed set of use cases, the way 2BingLing keeps `data/tag-alias.json` to
// merge synonyms. Everything the reader picks in "你想用 DSH 做什么？" comes from here.
//
// `aliases` are matched case-insensitively against a raw tag before any substring
// fallback, so 语音识别/asr both land on `voice` and 多智能体协作 lands on `agents`.

export const USECASES = [
  { id: 'finance', zh: '记账与财务', en: 'Bookkeeping', aliases: ['记账', '财务', '发票', '报销', '账本', '会计', 'bookkeeping', 'ledger'] },
  { id: 'finance-market', zh: '行情与投资', en: 'Markets', aliases: ['加密货币', '行情', '基金', '股票', '财报', '币价', 'crypto', 'stock'] },
  { id: 'subtitle', zh: '字幕与转写', en: 'Subtitles', aliases: ['字幕', '转写', '语音识别', '转录', 'asr', 'speech-to-text'] },
  { id: 'translate', zh: '翻译与多语言', en: 'Translation', aliases: ['翻译', 'translate', '多语言', '本地化', 'i18n', '语言包'] },
  { id: 'files', zh: '文件与网盘', en: 'Files & cloud', aliases: ['网盘', '云盘', '文件管理', '同步', '压缩', '解压', '下载器', 'file', 'drive'] },
  { id: 'browse', zh: '浏览器与抓取', en: 'Browser & scraping', aliases: ['浏览器', '网页', '爬虫', '抓取', 'browser', 'scrape', 'playwright', 'rss'] },
  { id: 'knowledge', zh: '搜索与知识库', en: 'Search & knowledge', aliases: ['知识库', '检索', '搜索', 'rag', '联网搜索', 'search'] },
  { id: 'analysis', zh: '数据分析', en: 'Data analysis', aliases: ['数据分析', '可视化', '图表', '报表', '统计', 'analytics', 'dashboard'] },
  { id: 'image', zh: '图像与视觉', en: 'Images', aliases: ['图像', '绘画', '图片', 'ocr', '截图', '视觉理解', 'image', 'vision'] },
  { id: 'video', zh: '视频', en: 'Video', aliases: ['视频', '剪辑', '播放', 'video'] },
  { id: 'voice', zh: '语音与音频', en: 'Voice & audio', aliases: ['语音', '语音合成', 'tts', '音频', '音乐', 'voice', 'audio'] },
  { id: 'code', zh: '代码与评审', en: 'Code & review', aliases: ['代码审查', '代码评审', 'git', '重构', 'diff', 'code-review'] },
  { id: 'cli', zh: '终端与命令', en: 'Terminal & CLI', aliases: ['命令行工具', '终端', 'shell', 'cli', 'terminal', '命令'] },
  { id: 'agents', zh: '智能体与编排', en: 'Agents', aliases: ['多智能体协作', '智能体', '编排', '子代理', 'agent', 'multi-agent', 'orchestr'] },
  { id: 'automation', zh: '工作流与自动化', en: 'Automation', aliases: ['工作流增强', '工作流', '自动化', '定时任务', 'workflow', 'automation', 'cron'] },
  { id: 'prompts', zh: '提示词与技能', en: 'Prompts & skills', aliases: ['提示词', '技能', '预设', 'prompt', 'skill', 'persona'] },
  { id: 'memory', zh: '记忆与上下文', en: 'Memory', aliases: ['记忆', '上下文', 'memory', 'context', '压缩上下文'] },
  { id: 'models', zh: '模型接入', en: 'Models', aliases: ['模型配置', '模型适配', '多模型', '大模型', 'llm', 'model', '供应商'] },
  { id: 'billing', zh: '用量与成本', en: 'Usage & cost', aliases: ['成本控制', '用量统计', '计费', '额度', 'usage', 'billing', 'token 统计'] },
  { id: 'notify', zh: '通知与推送', en: 'Notifications', aliases: ['消息通知', '通知', '钉钉', '飞书', '微信', 'telegram', 'webhook', 'notify', 'push'] },
  { id: 'email', zh: '邮件', en: 'Email', aliases: ['邮件', 'email', '邮箱', 'mail'] },
  { id: 'calendar', zh: '日程与待办', en: 'Calendar & tasks', aliases: ['日程', '待办', '番茄钟', '提醒', 'todo', 'calendar', 'task'] },
  { id: 'writing', zh: '笔记与写作', en: 'Writing', aliases: ['笔记', '写作', '小说', '剧本', 'note', 'writing', 'novel'] },
  { id: 'docs', zh: '表格与文档', en: 'Docs & sheets', aliases: ['表格', '文档', 'pdf', 'markdown', '导出', 'docx', 'docs'] },
  { id: 'ui', zh: '界面与主题', en: 'Interface', aliases: ['界面美化', '前端增强', '主题', '皮肤', '壁纸', '侧边栏', 'theme', 'ui', '界面'] },
  { id: 'settings', zh: '设置与配置', en: 'Settings', aliases: ['设置面板', '零配置', '配置管理', 'settings', 'config'] },
  { id: 'monitor', zh: '监控与诊断', en: 'Monitoring', aliases: ['状态监控', '运行时诊断', '日志', '状态持久化', '健康检查', 'monitor', 'diagnos', 'log'] },
  { id: 'security', zh: '安全与权限', en: 'Security', aliases: ['安全审查', '权限', '加密', '脱敏', '审计', 'security', 'permission', 'encrypt'] },
  { id: 'market', zh: '插件市场', en: 'Plugin market', aliases: ['插件管理', '插件市场', 'plugin-market', 'marketplace'] },
  { id: 'plugin-dev', zh: '插件开发', en: 'Plugin dev', aliases: ['插件开发', 'cordis', 'bundle', 'sdk', '开发者体验'] },
  { id: 'remote', zh: '远程与内网', en: 'Remote access', aliases: ['远程', '内网穿透', 'tailscale', 'ssh', 'remote', 'tunnel'] },
  { id: 'mobile', zh: '手机与移动端', en: 'Mobile', aliases: ['移动端', '手机', '安卓', 'ios', 'mobile'] },
  { id: 'fun', zh: '娱乐与彩蛋', en: 'Just for fun', aliases: ['娱乐互动', '娱乐', '彩蛋', '游戏', '摸鱼', 'fun', 'game', 'meme'] },
  { id: 'pet', zh: '桌宠与挂件', en: 'Widgets & pets', aliases: ['桌宠', '挂件', '动画', 'pet', 'widget'] },
]

const INDEX = new Map()
for (const usecase of USECASES) {
  for (const alias of usecase.aliases) INDEX.set(alias.toLowerCase(), usecase.id)
}

// Substring fallback, longest alias first, so a tag like "语音识别插件" still resolves.
const ORDERED = [...INDEX.entries()].sort((a, b) => b[0].length - a[0].length)

export function usecasesOf(rawTags) {
  if (!Array.isArray(rawTags) || !rawTags.length) return []
  const found = new Set()
  for (const raw of rawTags) {
    const tag = String(raw).toLowerCase().trim()
    if (!tag) continue
    const exact = INDEX.get(tag)
    if (exact) { found.add(exact); continue }
    for (const [alias, id] of ORDERED) {
      if (alias.length >= 2 && tag.includes(alias)) { found.add(id); break }
    }
  }
  return [...found]
}
// Category -> use case, so an entry from a catalogue without tags still joins the
// quiz. Tags remain the primary signal; this is the floor, not the ceiling.
export const CATEGORY_USECASES = {
  'enhance-ui': ['ui'],
  'enhance-models': ['models'],
  'enhance-usage': ['billing'],
  'enhance-tools': ['cli'],
  'enhance-memory': ['memory'],
  'enhance-settings': ['settings'],
  'agent-orchestration': ['agents'],
  'agent-skills': ['prompts'],
  'agent-workflow': ['automation'],
  'data-search': ['knowledge'],
  'data-docs': ['docs'],
  'data-office': ['writing'],
  'data-analysis': ['analysis'],
  'media-vision': ['image'],
  'media-voice': ['voice'],
  'media-fun': ['fun'],
  'connect-im': ['notify'],
  'connect-web': ['browse'],
  'connect-remote': ['remote'],
  'connect-files': ['files'],
  'dev-git': ['code'],
  'dev-runtime': ['plugin-dev'],
  'ops-security': ['security'],
  'ops-monitor': ['monitor'],
  'eco-market': ['market'],
}
