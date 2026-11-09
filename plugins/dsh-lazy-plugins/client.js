/**
 * dsh-lazy-plugins — browser half.
 *
 * Two jobs:
 *
 * 1. Trigger 2 (the original one): ping `GET /lazy-plugins/refresh` on mount and whenever the
 *    Plugins panel becomes the visible main panel, so "panel-triggered refresh" is real rather
 *    than theoretical. Throttled in the page and again on the host.
 *
 * 2. The management tab. The official Plugins page exposes `plugins.tab` — "Tabs after the
 *    page's own Installed tab, such as Discover". Registering there keeps the shipped page,
 *    its install flow and its per-bundle pages intact, and adds what this plugin knows and the
 *    panel does not: which bundles have their tools proxied away, how often each was loaded,
 *    and the actions that only exist here (update, adopt/unadopt).
 *
 *    Deliberately a tab and not a replacement of `main#plugins`: that key is a keyed slot with
 *    `replaceRisk: shadows-shipped-ui`, and shadowing it would take the official install path
 *    down with it. dsh-plugin-catalog does the same thing the other way round — it disables the
 *    built-in list row and renders its own tab — which is the precedent for staying additive.
 *
 * The runtime gives a dynamic client half four things and nothing else: a restricted `ctx`
 * (get/on/provide/effect), `React` without JSX, same-origin fetch, and `styles.insert`.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-lazy-plugins',
  factory: (require) => {
    var module = { exports: {} }

    const ENDPOINT = '/lazy-plugins/refresh'
    const API_LIST = '/lazy-plugins/api/list'
    const API_ACT = '/lazy-plugins/api/act'
    const THROTTLE_MS = 60000
    const STORAGE_KEY = 'dsh-lazy-plugins:last-ping-at'
    const PANEL_ID = 'plugins'

    // ---- trigger 2 -----------------------------------------------------------
    let lastPing = 0

    const storedAt = () => {
      try {
        return Number(window.sessionStorage.getItem(STORAGE_KEY)) || 0
      } catch {
        return 0
      }
    }

    const ping = (source) => {
      const now = Date.now()
      if (now - Math.max(lastPing, storedAt()) < THROTTLE_MS) return
      lastPing = now
      try {
        window.sessionStorage.setItem(STORAGE_KEY, String(now))
      } catch {
        /* private mode */
      }
      fetch(ENDPOINT + '?src=' + source, { credentials: 'same-origin' }).catch(() => {
        console.debug('[dsh-lazy-plugins] refresh ping failed')
      })
    }

    // ---- the tab -------------------------------------------------------------
    const CSS = `
.dshlz{font:12px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif;padding:8px 2px 16px;color:inherit}
.dshlz-bar{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.dshlz-bar b{font-size:13px}
.dshlz-mut{opacity:.65}
.dshlz-btn{border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer}
.dshlz-btn:hover{background:rgba(127,127,127,.12)}
.dshlz-btn[disabled]{opacity:.5;cursor:default}
.dshlz-btn.warn:hover{background:rgba(220,80,80,.18);border-color:rgba(220,80,80,.5)}
.dshlz tab{display:table;width:100%;border-collapse:collapse}
.dshlz-row{display:grid;grid-template-columns:minmax(160px,2fr) 90px 70px 60px minmax(180px,1.4fr);gap:8px;align-items:center;padding:5px 4px;border-top:1px solid rgba(127,127,127,.18)}
.dshlz-row.head{border-top:0;font-weight:600;opacity:.7;font-size:11px}
.dshlz-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshlz-tag{border-radius:4px;padding:0 5px;font-size:10px;background:rgba(127,127,127,.18)}
.dshlz-tag.on{background:rgba(90,200,140,.22)}
.dshlz-tag.off{background:rgba(127,127,127,.18)}
.dshlz-tag.hide{background:rgba(90,130,220,.22)}
.dshlz-acts{display:flex;gap:4px;flex-wrap:wrap}
.dshlz-msg{margin-top:8px;font-size:11px;opacity:.8;min-height:14px}
.dshlz-err{color:#e06c6c}
`

    const fmtTime = (iso) => {
      if (!iso) return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      const minutes = Math.round((Date.now() - date.getTime()) / 60000)
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return minutes + ' 分钟前'
      if (minutes < 60 * 24) return Math.round(minutes / 60) + ' 小时前'
      return Math.round(minutes / 1440) + ' 天前'
    }

    const Panel = () => {
      const React = globals.React ?? window.React ?? require('React')
      const [state, setState] = React.useState({ loading: true, data: null, error: null, message: null, busy: null })

      const load = React.useCallback(() => {
        setState((prev) => ({ ...prev, loading: true, error: null }))
        fetch(API_LIST, { credentials: 'same-origin' })
          .then((response) => response.json())
          .then((data) => setState((prev) => ({ ...prev, loading: false, data })))
          .catch((error) => setState((prev) => ({ ...prev, loading: false, error: String(error && error.message || error) })))
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const act = (action, name, confirmText) => {
        if (confirmText && !window.confirm(confirmText)) return
        setState((prev) => ({ ...prev, busy: action + ':' + name, message: null }))
        fetch(API_ACT, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, name }),
        })
          .then((response) => response.json())
          .then((result) => {
            setState((prev) => ({
              ...prev,
              busy: null,
              message: result.ok ? action + ' ' + name + ' ✓' : action + ' ' + name + ' 失败：' + JSON.stringify(result.error || result),
            }))
            load()
          })
          .catch((error) => setState((prev) => ({ ...prev, busy: null, message: '请求失败：' + String(error && error.message || error) })))
      }

      const h = React.createElement
      const data = state.data
      const rows = (data && data.rows) || []

      const header = h('div', { className: 'dshlz-bar' },
        h('b', null, '按需加载'),
        h('span', { className: 'dshlz-mut' },
          data
            ? `${rows.length} 个已装 · 工具 ${data.tools.count} 个（其中 ${data.tools.hidden} 个被按需屏蔽） · runtime ${data.runtime || '?'}`
            : '加载中…'),
        h('button', { className: 'dshlz-btn', onClick: load, disabled: state.loading }, '刷新'),
      )

      const head = h('div', { className: 'dshlz-row head' },
        h('div', null, '插件'),
        h('div', null, '版本'),
        h('div', null, '状态'),
        h('div', null, '装载'),
        h('div', null, '操作'),
      )

      const body = rows.map((row) => h('div', { className: 'dshlz-row', key: row.name },
        h('div', { className: 'dshlz-name', title: row.name },
          row.name,
          row.resident === 'base' ? h('span', { className: 'dshlz-tag' }, ' base') : null,
          row.resident === 'auto' ? h('span', { className: 'dshlz-tag' }, ' 常驻') : null,
        ),
        h('div', { className: 'dshlz-mut' }, row.version || '?'),
        h('div', null,
          h('span', { className: 'dshlz-tag ' + (row.enabled ? 'on' : 'off') }, row.enabled ? '启用' : '停用'),
          row.hiddenTools ? h('span', { className: 'dshlz-tag hide' }, ' 屏蔽 ' + row.hiddenTools) : null,
        ),
        h('div', { className: 'dshlz-mut' }, String(row.loads || 0)),
        h('div', { className: 'dshlz-acts' },
          h('button', {
            className: 'dshlz-btn',
            disabled: state.busy !== null,
            onClick: () => act(row.enabled ? 'disable' : 'enable', row.name),
          }, row.enabled ? '停用' : '启用'),
          h('button', { className: 'dshlz-btn', disabled: state.busy !== null, onClick: () => act('reload', row.name) }, '重载'),
          h('button', {
            className: 'dshlz-btn',
            disabled: state.busy !== null || !row.updatable,
            title: row.updatable ? '安装 registry 上的新版本' : '不可更新（官方 bundle 跟随 DSH 版本或未安装）',
            onClick: () => act('update', row.name),
          }, '更新'),
          h('button', {
            className: 'dshlz-btn',
            disabled: state.busy !== null,
            title: '把它的工具从模型视野里隐藏，仍可通过 invoke 调用',
            onClick: () => act('adopt', row.name),
          }, row.hiddenTools ? '重新识别' : '纳入按需'),
          row.removable ? h('button', {
            className: 'dshlz-btn warn',
            disabled: state.busy !== null,
            onClick: () => act('remove', row.name, '移除 ' + row.name + ' ？'),
          }, '移除') : null,
        ),
      ))

      return h('div', { className: 'dshlz' },
        header,
        state.error ? h('div', { className: 'dshlz-msg dshlz-err' }, '读取失败：' + state.error) : null,
        h('div', null, head, body),
        h('div', { className: 'dshlz-msg' }, state.message || ''),
      )
    }

    // ---- registration -------------------------------------------------------
    // Two rules learned the hard way (crash-2026-11-09T08-00-18-154Z-web-boot.log:
    // "@local/dsh-lazy-plugins: loading" → "web boot: 1 entry did not activate" → the app reset
    // the profile):
    //   1. never declare `inject` for a slot service — an unresolved inject leaves the entry
    //      "loading" forever and the whole web boot fails;
    //   2. never throw out of `apply` — retry for the service instead.
    const globals = typeof globalThis !== 'undefined' ? globalThis : window

    const tryRegister = (ctx, attempt) => {
      const slots = ctx.slots ?? ctx.get?.('slots')
      if (slots && typeof slots.inject === 'function') {
        try {
          slots.inject('plugins.tab', () =>
            slots.register({ name: 'plugins.tab', id: 'dsh-lazy-plugins', order: 90, label: () => '按需加载' }, Panel),
          )
          return true
        } catch (error) {
          console.warn('[dsh-lazy-plugins] tab registration failed:', error)
          return false
        }
      }
      // The slot service appears after boot; poll a few times and then give up quietly.
      if (attempt < 5) {
        setTimeout(() => tryRegister(ctx, attempt + 1), 400 * (attempt + 1))
      } else {
        console.warn('[dsh-lazy-plugins] slots never appeared; the 按需加载 tab is unavailable')
      }
      return false
    }

    const apply = (ctx) => {
      // Whatever happens here must not propagate: a throwing client entry fails the web boot.
      try {
        const inserter = globals.styles ?? ctx.get?.('styles')
        if (inserter && typeof inserter.insert === 'function') inserter.insert(CSS)
      } catch (error) {
        console.warn('[dsh-lazy-plugins] styles unavailable:', error)
      }
      try {
        tryRegister(ctx, 0)
      } catch (error) {
        console.warn('[dsh-lazy-plugins] tab registration threw:', error)
      }
      try {
        // Trigger 2: page mount, then every time the Plugins panel becomes visible.
        ping('mount')
        const layout = ctx.layout ?? ctx.get?.('layout')
        if (layout && typeof layout.on === 'function') {
          layout.on('panel', (info) => {
            if (info && info.activePanelId === PANEL_ID) ping('panel')
          })
        }
      } catch (error) {
        console.warn('[dsh-lazy-plugins] panel trigger unavailable:', error)
      }
    }

    module.exports = { apply }
    return module.exports
  },
})
