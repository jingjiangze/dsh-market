/**
 * dsh-lazy-plugins — browser half (Trigger 2: the plugin panel opens).
 *
 * The host half registers `GET /lazy-plugins/refresh`; nothing ever called it from
 * the page, so "panel-triggered refresh" stayed theoretical. This file is the
 * missing caller. It is hand-written in the same shape the client-module system
 * serves to the browser: a factory registration (`window.__ModuleLoader__.load`),
 * because `@deepseek-ai/dsh-client-modules` concatenates the built bundle
 * (`exports['./client']`) verbatim into a classic-script combo — a plain ESM
 * module with `export` statements would not parse there.
 *
 * Behaviour:
 *   - mount      — one same-origin GET on page boot (`immediately: true`), which
 *                  also covers "user opened the Harness UI" when no panel mount
 *                  event is observable;
 *   - panel      — one GET each time the Plugins panel becomes the visible main
 *                  panel (`ctx.layout.panelInfo.activePanelId === 'plugins'`).
 * Both are throttled for 60 s in the page (module variable + sessionStorage), and
 * the host throttles again (`panelThrottleMs`) so a remount loop cannot storm.
 * Every failure is silent apart from a `console.debug`.
 *
 * No React, no slots, no styles: this half renders nothing.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-lazy-plugins',
  factory: (require) => {
    var module = { exports: {} }

    const NS = 'dsh-lazy-plugins'
    // Same-origin host route (registered on the webServer by index.js).
    const ENDPOINT = '/lazy-plugins/refresh'
    const THROTTLE_MS = 60000
    const STORAGE_KEY = 'dsh-lazy-plugins:last-ping-at'
    // Main-slot occupant id of the sidebar Plugins panel
    // (@deepseek-ai/dsh-client-ui-plugin-manager: PANEL_ID = 'plugins').
    const PANEL_ID = 'plugins'

    let lastPing = 0

    const storedAt = () => {
      try {
        return Number(window.sessionStorage.getItem(STORAGE_KEY)) || 0
      } catch (_error) {
        return 0
      }
    }

    const rememberAt = (at) => {
      try {
        window.sessionStorage.setItem(STORAGE_KEY, String(at))
      } catch (_error) {
        // private mode / storage disabled: the module variable still throttles
      }
    }

    /** Fire one refresh request, at most once per THROTTLE_MS per page session. */
    const ping = (reason) => {
      const now = Date.now()
      if (now - Math.max(lastPing, storedAt()) < THROTTLE_MS) return false
      lastPing = now
      rememberAt(now)
      try {
        // `credentials: same-origin` keeps the request inside the authenticated page;
        // the host answers with the refreshed cache state, which this half ignores.
        fetch(`${ENDPOINT}?src=${encodeURIComponent(reason)}`, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        }).catch((error) => {
          console.debug(`[${NS}] ${reason} refresh failed:`, error?.message ?? error)
        })
      } catch (error) {
        console.debug(`[${NS}] ${reason} refresh threw:`, error?.message ?? error)
      }
      return true
    }

    /**
     * Watch the layout store's active main panel. `ctx.layout` is provided by
     * @deepseek-ai/dsh-client-ui-layout; `panelInfo` is the root store's
     * `{ getSnapshot, subscribe }` source of the central-panel selection.
     */
    const watchPanel = (ctx) => {
      const info = ctx?.layout?.panelInfo
      if (!info || typeof info.subscribe !== 'function' || typeof info.getSnapshot !== 'function') {
        console.debug(`[${NS}] layout.panelInfo unavailable; panel trigger stays mount-only`)
        return
      }
      ctx.effect(() => {
        let visible = false
        const check = () => {
          let active = null
          try {
            active = info.getSnapshot()?.activePanelId ?? null
          } catch (_error) {
            return
          }
          const next = active === PANEL_ID
          if (next && !visible) ping('panel')
          visible = next
        }
        check()
        const off = info.subscribe(check)
        return () => {
          try {
            off?.()
          } catch (_error) {
            // subscription already gone
          }
        }
      }, `${NS}: panel visibility`)
    }

    const apply = (ctx) => {
      // Mount / page boot: the cheapest moment that is still "the user is here".
      ping('mount')
      // Panel visibility is optional: a layout change must never break the plugin.
      try {
        if (typeof ctx.inject === 'function') ctx.inject(['layout'], (scoped) => watchPanel(scoped))
        else watchPanel(ctx)
      } catch (error) {
        console.debug(`[${NS}] panel trigger unavailable:`, error?.message ?? error)
      }
    }

    module.exports = { apply, name: NS }
    return module.exports
  },
})
