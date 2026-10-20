/* Persistent webviews with a session-scoped DSH sidebar presentation. */
window.__ModuleLoader__.load({
  id: 'dsh-sidebar-browser-control',
  factory: (require) => {
    const React = require('react');
    const icons = require('@deepseek-ai/dsh-client-ui-primitives');
    // Keep BUILD synchronized with package.json; the compatibility test checks it.
    const BUILD = '0.7.0',
      PROTOCOL = 2,
      KIND = 'agent-browser',
      PROVIDER = 'dsh-sidebar-browser-control';
    const h = React.createElement;
    const keyFor = (session, id) => JSON.stringify([session, id]);

    // ---- Compatibility ---------------------------------------------------
    function missingApis(ctx, sidebar, bridge) {
      const missing = [];
      for (const method of ['acquire', 'release'])
        if (typeof bridge?.[method] !== 'function')
          missing.push(`browser.${method}`);
      for (const method of [
        'openTabIn',
        'closeIn',
        'tabsIn',
        'actionsFor',
        'active',
        'isExpanded',
      ])
        if (typeof sidebar?.[method] !== 'function')
          missing.push(`sidebar.${method}`);
      if (typeof sidebar?.mounted?.getSnapshot !== 'function')
        missing.push('sidebar.mounted.getSnapshot');
      for (const [object, method] of [
        [ctx.sidebarRightTabs, 'register'],
        [ctx.slots, 'inject'],
        [ctx.slots, 'register'],
      ])
        if (typeof object?.[method] !== 'function') missing.push(method);
      return missing;
    }
    // DOM markup is not an API DSH declares; detect when it stops matching.
    function diagnostics(sidebar, nativeView) {
      const session = sidebar.mounted.getSnapshot(),
        warnings = [],
        protocol = window.dshDesktop?.protocolVersion;
      const native = session
        ? sidebar.tabsIn(session).filter((t) => t.kind === 'browser')
        : [];
      const controllable = native.filter((t) =>
        nativeView(session, t.id),
      ).length;
      const active = sidebar.active?.();
      if (
        active?.kind === 'browser' &&
        sidebar.isExpanded() &&
        !nativeView(session, active.id)
      )
        warnings.push(
          'The visible DSH browser tab has no webview matching webview[data-sidebar-browser-frame] inside [data-sidebar-right-session] and [data-sidebar-right-tab]. DSH markup may have changed: native-tab control is unavailable until the plugin is updated.',
        );
      if (protocol !== 1)
        warnings.push(
          `DSH desktop protocol ${protocol ?? 'unknown'} is not the tested version 1; the browser bridge may behave differently.`,
        );
      return {
        desktopProtocol: protocol ?? null,
        nativeTabs: native.length,
        controllableNativeTabs: controllable,
        warnings,
      };
    }

    // ---- Settings card ---------------------------------------------------
    const SETTINGS = [
      [
        'checkForUpdates',
        'Check for plugin updates',
        'Check GitHub releases at most once a day and tell you when a new version is available.',
      ],
    ];
    function installSettings(ctx) {
      // DSH's settings transport and plugin-card slot; no application bundle patching.
      ctx.inject?.(['configForms'], (settings) => {
        const directory = settings.configForms.describe();
        function Toggle({ state, saving, name, label, help, onChange }) {
          return h(
            'div',
            { style: { display: 'grid', gap: '4px' } },
            h(
              'label',
              { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
              h('input', {
                type: 'checkbox',
                role: 'switch',
                'aria-label': label,
                checked: state.value?.[name] !== false,
                disabled: saving || state.status !== 'ready' || !state.writable,
                onChange: (e) => onChange(name, e.target.checked),
              }),
              label,
            ),
            h('p', { style: { margin: 0, opacity: 0.75 } }, help),
          );
        }
        function SettingsCard(props) {
          const [state, setState] = React.useState(() =>
            props.scope.getSnapshot(),
          );
          const [saving, setSaving] = React.useState(false),
            [error, setError] = React.useState('');
          React.useEffect(
            () =>
              props.scope.subscribe(() => setState(props.scope.getSnapshot())),
            [props.scope],
          );
          if (props.view === 'summary')
            return 'Background browser control and update preferences.';
          const onChange = async (name, value) => {
            setSaving(true);
            setError('');
            try {
              if (!(await props.scope.set(name, value)))
                setError('Could not save. Please try again.');
            } catch {
              setError('Could not save. Please try again.');
            } finally {
              setSaving(false);
            }
          };
          return h(
            'div',
            { style: { padding: '12px', display: 'grid', gap: '14px' } },
            ...SETTINGS.map(([name, label, help]) =>
              h(Toggle, {
                key: name,
                state,
                saving,
                name,
                label,
                help,
                onChange,
              }),
            ),
            error ? h('p', { role: 'alert' }, error) : null,
          );
        }
        let unregister, namespace;
        const sync = () => {
          const ns = directory
            .getSnapshot()
            .view?.namespaces.find(
              (n) => n.value && Object.hasOwn(n.value, 'checkForUpdates'),
            )?.ns;
          if (ns === namespace) return;
          unregister?.();
          namespace = ns;
          if (ns)
            unregister = settings.slots.inject('plugins.bundle.config', () =>
              settings.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: PROVIDER,
                  inject: () => ({ scope: settings.configForms.get(ns) }),
                },
                SettingsCard,
              ),
            );
        };
        settings.effect(() => {
          const off = directory.subscribe(sync);
          void directory.ensure();
          sync();
          return () => {
            off();
            unregister?.();
          };
        });
      });
    }

    // ---- Page registry and agent API ---------------------------------------
    function createPages({ sidebar, bridge, requestLayout }) {
      const owned = new Map(),
        panels = new Map();
      let disposed = false,
        backgroundSequence = 0;
      const check = (session) => {
        if (typeof session !== 'string' || !session)
          throw new Error('A calling chat ID is required');
        if (!sidebar.actionsFor(session))
          throw new Error('Calling chat is not loaded in this DSH window');
      };
      const nativeTab = (session, id) =>
        sidebar
          .tabsIn(session)
          .find((t) => t.id === id && t.kind === 'browser');
      const nativeView = (session, id) =>
        [
          ...document.querySelectorAll(
            'webview[data-sidebar-browser-frame="webview"]',
          ),
        ].find(
          (v) =>
            v.closest('[data-sidebar-right-session]')?.dataset
              .sidebarRightSession === session &&
            v.closest('[data-sidebar-right-tab]')?.dataset.sidebarRightTab ===
              id,
        );
      const nativePage = (session, id) => {
        if (!nativeTab(session, id)) return;
        const view = nativeView(session, id);
        if (!view) {
          const { warnings } = diagnostics(sidebar, nativeView);
          throw new Error(
            warnings[0] ??
              'Native browser tab has no running page. Open or restore it in DSH first; do not retry in a loop.',
          );
        }
        return {
          native: true,
          session,
          tabId: id,
          sidebarTabId: id,
          view,
          lease: view.getAttribute('name'),
        };
      };
      const get = (session, id) => {
        check(session);
        const page = owned.get(keyFor(session, id)) ?? nativePage(session, id);
        if (!page || page.session !== session)
          throw new Error('Unknown tab or tab belongs to another chat');
        if (
          page.sidebarTabId &&
          !sidebar.tabsIn(session).some((t) => t.id === page.sidebarTabId)
        )
          throw new Error('Sidebar tab has been closed');
        return page;
      };
      const release = async (key) => {
        const page = owned.get(key);
        if (!page) return;
        owned.delete(key);
        page.unsubscribe?.();
        page.container.remove();
        await bridge.release(page.lease);
      };
      const validURL = (value) => {
        const u = new URL(value);
        if (
          !['http:', 'https:'].includes(u.protocol) ||
          u.username ||
          u.password
        )
          throw new Error('HTTP(S) URL required');
        return u.href;
      };
      const openPresentation = (session, url) => {
        const before = new Set(sidebar.tabsIn(session).map((t) => t.id));
        sidebar.openTabIn(session, KIND, { params: { url } });
        return sidebar
          .tabsIn(session)
          .find((t) => t.kind === KIND && !before.has(t.id));
      };
      const parked = {
        left: '0px',
        top: '0px',
        width: '1100px',
        height: '760px',
        pointerEvents: 'none',
        opacity: '0',
      };
      async function openNative(session, url) {
        const before = new Set(sidebar.tabsIn(session).map((t) => t.id));
        sidebar.openTabIn(session, 'browser', { params: { url } });
        const tab = sidebar
          .tabsIn(session)
          .find((t) => t.kind === 'browser' && !before.has(t.id));
        if (!tab) throw new Error('DSH did not create a native browser tab');
        for (let i = 0; i < 80; i++) {
          const view = nativeView(session, tab.id);
          if (view) {
            try {
              view.getURL();
              return { tabId: tab.id, background: false, native: true };
            } catch {}
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        return {
          tabId: tab.id,
          background: false,
          native: true,
          loading: true,
        };
      }
      // The webview never changes DOM parents: Electron can destroy a guest on
      // reparenting. Transparent parked pages keep a composited viewport.
      async function openOwned(session, url, background, options) {
        const tab = background
          ? { id: `background-${++backgroundSequence}` }
          : openPresentation(session, url);
        if (!tab)
          throw new Error(
            'DSH did not create a sidebar tab for the calling chat',
          );
        const key = keyFor(session, tab.id);
        let reservation, container;
        try {
          // One private storage partition per chat, separate from DSH's
          // own browser tabs and from every other chat.
          reservation = await bridge.acquire(`dsh-sidebar-control:${session}`);
          if (disposed) throw new Error('Plugin was unloaded');
          container = document.createElement('div');
          Object.assign(container.style, {
            position: 'fixed',
            zIndex: '20',
            ...parked,
          });
          container.dataset.sidebarControlSession = session;
          container.dataset.sidebarControlTab = tab.id;
          const view = document.createElement('webview');
          view.dataset.sidebarBrowserFrame = 'webview';
          view.setAttribute('tabindex', '-1');
          view.setAttribute('name', reservation.lease);
          view.setAttribute('partition', reservation.partition);
          view.setAttribute('allowpopups', '');
          view.setAttribute('src', `about:blank#${reservation.lease}`);
          Object.assign(view.style, {
            width: '100%',
            height: '100%',
            display: 'flex',
          });
          const ready = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              view.removeEventListener('dom-ready', loaded);
              reject(new Error('Webview initialization timed out'));
            }, 8000);
            const loaded = () => {
              clearTimeout(timer);
              resolve();
            };
            view.addEventListener('dom-ready', loaded, { once: true });
          });
          const page = {
            session,
            tabId: tab.id,
            sidebarTabId: background ? null : tab.id,
            lease: reservation.lease,
            container,
            view,
            options,
          };
          owned.set(key, page);
          container.append(view);
          document.body.append(container);
          await ready;
          page.unsubscribe = bridge.onOpenRequested?.(
            reservation.lease,
            (request) => {
              void api
                .open(
                  session,
                  request.url ?? request,
                  !page.sidebarTabId,
                  options,
                )
                .catch(console.error);
            },
          );
          void view.loadURL(url).catch((error) => {
            page.loadError = error.message;
          });
          requestLayout(true);
          return { tabId: tab.id, background };
        } catch (error) {
          if (owned.has(key)) await release(key);
          else {
            container?.remove();
            if (reservation) await bridge.release(reservation.lease);
          }
          if (!background) sidebar.closeIn(session, tab.id);
          throw error;
        }
      }
      const visibleNative = (session, id) =>
        sidebar.mounted.getSnapshot() === session &&
        sidebar.active()?.id === id &&
        sidebar.isExpanded();
      const api = {
        version: PROTOCOL,
        build: BUILD,
        status() {
          return {
            version: PROTOCOL,
            build: BUILD,
            visibleSession: sidebar.mounted.getSnapshot() ?? null,
            tabs: owned.size,
            diagnostics: diagnostics(sidebar, nativeView),
          };
        },
        hasSession(session) {
          return {
            loaded: !!sidebar.actionsFor(session),
            visible: sidebar.mounted.getSnapshot() === session,
          };
        },
        async open(session, value, background = true, options = {}) {
          check(session);
          const url = validURL(value);
          if (!background && sidebar.mounted.getSnapshot() === session)
            return openNative(session, url);
          return openOwned(session, url, background, options);
        },
        list(session) {
          check(session);
          return [
            ...[...owned.values()]
              .filter((p) => p.session === session)
              .map((p) => ({
                tabId: p.tabId,
                background: !p.sidebarTabId,
                native: false,
                url: p.view.getURL(),
                title: p.view.getTitle(),
                ...(p.loadError ? { loadError: p.loadError } : {}),
              })),
            ...sidebar
              .tabsIn(session)
              .filter((t) => t.kind === 'browser')
              .map((t) => {
                const view = nativeView(session, t.id);
                let url, title;
                try {
                  url = view?.getURL();
                  title = view?.getTitle();
                } catch {}
                return {
                  tabId: t.id,
                  native: true,
                  controllable: !!view,
                  url: url ?? null,
                  title: title ?? t.title,
                  background: !visibleNative(session, t.id),
                };
              }),
          ];
        },
        focus(session, id) {
          check(session);
          const actions = sidebar.actionsFor(session);
          if (nativeTab(session, id)) {
            actions.focusTab(session, id);
            actions.setExpanded(session, true);
            return {
              tabId: id,
              native: true,
              visible: sidebar.mounted.getSnapshot() === session,
            };
          }
          const page = get(session, id);
          if (!page.sidebarTabId) {
            const tab = openPresentation(session, page.view.getURL());
            if (!tab)
              throw new Error('DSH did not create a sidebar presentation');
            page.sidebarTabId = tab.id;
          }
          actions.focusTab(session, page.sidebarTabId);
          requestLayout(true);
          return {
            tabId: id,
            visible: sidebar.mounted.getSnapshot() === session,
          };
        },
        navigate(session, id, mode) {
          const view = get(session, id).view;
          if (mode === 'reload') {
            view.reload();
            return { reloading: true };
          }
          if (mode === 'back' || mode === 'forward') {
            const available =
              mode === 'back' ? view.canGoBack() : view.canGoForward();
            if (available) {
              if (mode === 'back') view.goBack();
              else view.goForward();
            }
            return { navigated: available };
          }
          throw new Error('Unsupported navigation mode');
        },
        hide(session, id) {
          check(session);
          if (nativeTab(session, id)) {
            sidebar.actionsFor(session).setExpanded(session, false);
            return {
              tabId: id,
              native: true,
              background: true,
              message:
                'The chat sidebar is collapsed; its native tabs remain open.',
            };
          }
          const page = get(session, id),
            tab = page.sidebarTabId;
          page.sidebarTabId = null;
          panels.delete(keyFor(session, id));
          if (tab) sidebar.closeIn(session, tab);
          requestLayout(true);
          return { tabId: id, background: true };
        },
        async close(session, id) {
          check(session);
          if (nativeTab(session, id)) {
            sidebar.closeIn(session, id);
            return { closed: id, native: true };
          }
          const page = get(session, id);
          await release(keyFor(session, id));
          if (page.sidebarTabId) sidebar.closeIn(session, page.sidebarTabId);
          return { closed: id };
        },
        lease(session, id) {
          return get(session, id).lease;
        },
        // Chromium produces no frames for opacity:0 layers, so captures of a
        // parked page stall: raise it imperceptibly for the capture only.
        // Hidden native tabs belong to DSH and cannot be raised.
        captureSurface(session, id, active) {
          check(session);
          if (nativeTab(session, id))
            return { native: true, visible: visibleNative(session, id) };
          const page = get(session, id);
          if (page.container.style.pointerEvents !== 'none')
            return { native: false, visible: true, raised: false };
          page.container.style.opacity = active ? '0.01' : '0';
          return { native: false, visible: false, raised: true };
        },
        visible(session) {
          return sidebar.mounted.getSnapshot() === session;
        },
      };
      return {
        api,
        owned,
        panels,
        release,
        validURL,
        parked,
        pageFor: (session, tabId) =>
          [...owned.values()].find(
            (p) => p.session === session && p.sidebarTabId === tabId,
          ),
        dispose: async () => {
          disposed = true;
          await Promise.all([...owned.keys()].map(release));
          panels.clear();
        },
      };
    }

    // ---- Layout ------------------------------------------------------------
    // Positions each revealed page's fixed container over its tab panel.
    function createLayout(sidebar, pages) {
      let frame = null,
        animateUntil = 0,
        stopped = false;
      const layout = () => {
        for (const [key, page] of pages.owned) {
          const id = page.sidebarTabId;
          if (id && !sidebar.tabsIn(page.session).some((t) => t.id === id)) {
            void pages.release(key).catch(console.error);
            continue;
          }
          const rect = pages.panels.get(key)?.getBoundingClientRect();
          const visible =
            sidebar.mounted.getSnapshot() === page.session &&
            sidebar.active()?.id === id &&
            sidebar.isExpanded() &&
            rect &&
            rect.width > 0 &&
            rect.height > 0;
          const signature = visible
            ? `${rect.left},${rect.top},${rect.width},${rect.height}`
            : 'hidden';
          if (page.layoutSignature === signature) continue;
          page.layoutSignature = signature;
          page.container.setAttribute('aria-hidden', String(!visible));
          Object.assign(
            page.container.style,
            visible
              ? {
                  left: `${rect.left}px`,
                  top: `${rect.top}px`,
                  width: `${rect.width}px`,
                  height: `${rect.height}px`,
                  pointerEvents: 'auto',
                  opacity: '1',
                }
              : pages.parked,
          );
        }
      };
      const request = (now = false) => {
        if (now === true) return layout();
        if (stopped || !pages.owned.size || frame !== null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          layout();
          if (Date.now() < animateUntil && pages.panels.size) request();
        });
      };
      return {
        request,
        animate() {
          if (!pages.panels.size) return;
          animateUntil = Date.now() + 500;
          request();
        },
        stop() {
          stopped = true;
          if (frame !== null) cancelAnimationFrame(frame);
        },
      };
    }

    // ---- Tab title, toolbar and body ----------------------------------------
    function createTabComponents(pages, requestLayout) {
      const watchPage = (page, update) => {
        if (!page) return () => {};
        const events = [
          'page-title-updated',
          'did-navigate',
          'did-navigate-in-page',
          'did-start-loading',
          'did-stop-loading',
          'dom-ready',
        ];
        for (const event of events) page.view.addEventListener(event, update);
        return () => {
          for (const event of events)
            page.view.removeEventListener(event, update);
        };
      };
      function Title(props) {
        const { tab } = props.useTabInfo();
        const [title, setTitle] = React.useState('Browser');
        React.useEffect(() => {
          const update = () => {
            const page = pages.pageFor(props.ownerSession, tab.id);
            let value = 'Browser';
            if (page) {
              try {
                value =
                  page.view.getTitle() ||
                  new URL(page.view.getURL()).hostname ||
                  'Browser';
              } catch {}
            }
            setTitle(value);
          };
          update();
          return watchPage(pages.pageFor(props.ownerSession, tab.id), update);
        }, [props.ownerSession, tab.id]);
        return h('span', { title }, title);
      }
      function Body(props) {
        const { tab } = props.useTabInfo();
        const match = pages.pageFor(props.ownerSession, tab.id);
        const key = keyFor(props.ownerSession, match?.tabId ?? tab.id);
        const panel = React.useRef(null),
          [url, setUrl] = React.useState(''),
          [navigation, setNavigation] = React.useState({
            back: false,
            forward: false,
          });
        React.useLayoutEffect(() => {
          pages.panels.set(key, panel.current);
          const observer = new ResizeObserver(() => requestLayout());
          observer.observe(panel.current);
          requestLayout();
          return () => {
            observer.disconnect();
            pages.panels.delete(key);
            requestLayout();
          };
        }, [key]);
        React.useEffect(() => {
          const update = () => {
            const p = pages.owned.get(key);
            if (!p) return;
            if (
              document.activeElement?.dataset.sidebarControlAddress !== tab.id
            )
              setUrl(p.view.getURL());
            setNavigation({
              back: p.view.canGoBack(),
              forward: p.view.canGoForward(),
            });
          };
          update();
          return watchPage(pages.owned.get(key), update);
        }, [key]);
        const page = () => pages.owned.get(key);
        const button = (label, icon, fn, disabled = false, type = 'button') =>
          h(
            'button',
            {
              className: 'dsh-agent-browser-tool',
              onClick: fn,
              type,
              disabled,
              'aria-label': label,
              title: label,
            },
            h(icons[icon]),
          );
        return h(
          'div',
          { className: 'dsh-agent-browser-root' },
          h(
            'form',
            {
              className: 'dsh-agent-browser-toolbar',
              onSubmit: (e) => {
                e.preventDefault();
                const p = page();
                if (p)
                  void p.view.loadURL(pages.validURL(url)).catch(console.error);
              },
            },
            button(
              'Back',
              'IconChevronLeftOutlineRegular',
              () => page()?.view.goBack(),
              !navigation.back,
            ),
            button(
              'Forward',
              'IconChevronRightOutlineRegular',
              () => page()?.view.goForward(),
              !navigation.forward,
            ),
            button(
              'Reload',
              'IconRefreshOutlineRegular',
              () => page()?.view.reload(),
              !page(),
            ),
            h(
              'div',
              { className: 'dsh-agent-browser-address-box' },
              h('input', {
                className: 'dsh-agent-browser-address',
                'aria-label': 'Browser address',
                'data-sidebar-control-address': tab.id,
                spellCheck: false,
                value: url,
                onChange: (e) => setUrl(e.target.value),
              }),
              button(
                'Go',
                'IconLinkOutlineRegular',
                undefined,
                false,
                'submit',
              ),
            ),
            button(
              'Open in external browser',
              'IconRightUpOutlineRegular',
              () => {
                const p = page();
                if (p)
                  window.open(
                    pages.validURL(p.view.getURL()),
                    '_blank',
                    'noopener,noreferrer',
                  );
              },
              !page(),
            ),
          ),
          h(
            'div',
            { ref: panel, style: { flex: 1, minHeight: 0 } },
            pages.owned.has(key)
              ? null
              : 'This browser page is no longer running. Ask the agent to open a new tab.',
          ),
        );
      }
      return { Title, Body };
    }
    const STYLES = `
.dsh-agent-browser-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.dsh-agent-browser-toolbar{display:flex;flex:0 0 auto;gap:4px;align-items:center;box-sizing:border-box;height:38px;padding:5px 6px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsh-agent-browser-tool{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:28px;height:28px;padding:0;color:var(--dsw-alias-label-secondary);background:transparent;border:0;border-radius:var(--dsw-radius-sm);cursor:pointer}
.dsh-agent-browser-tool svg{width:16px;height:16px}
.dsh-agent-browser-tool:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-agent-browser-tool:disabled{color:var(--dsw-alias-label-quaternary);cursor:default}
.dsh-agent-browser-address-box{position:relative;flex:1 1 auto;min-width:0}
.dsh-agent-browser-address{width:100%;height:28px;box-sizing:border-box;padding:0 34px 0 9px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dsh-agent-browser-address-box button{position:absolute;top:0;right:0;visibility:hidden}
.dsh-agent-browser-address-box:focus-within button{visibility:visible}
.dsh-agent-browser-address:focus{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}
`;

    // ---- Wiring ------------------------------------------------------------
    return {
      inject: ['sidebarRight', 'sidebarRightTabs', 'slots'],
      apply(ctx) {
        const sidebar = ctx.sidebarRight,
          bridge = window.dshDesktop?.browser;
        const missing = missingApis(ctx, sidebar, bridge);
        if (missing.length) {
          ctx.effect(() => {
            const api = {
              status: () => ({
                version: PROTOCOL,
                build: BUILD,
                compatibilityError: missing.join(', '),
              }),
              hasSession: (session) => ({
                loaded: !!sidebar?.actionsFor?.(session),
                visible: sidebar?.mounted?.getSnapshot?.() === session,
              }),
            };
            window.__dshSidebarControl = api;
            return () => {
              if (window.__dshSidebarControl === api)
                delete window.__dshSidebarControl;
            };
          });
          return;
        }
        installSettings(ctx);
        let layout;
        const pages = createPages({
          sidebar,
          bridge,
          requestLayout: (now) => layout.request(now),
        });
        layout = createLayout(sidebar, pages);
        const { Title, Body } = createTabComponents(pages, layout.request);
        ctx.effect(() => {
          const style = document.createElement('style');
          style.textContent = STYLES;
          document.body.append(style);
          return () => style.remove();
        });
        const slot = (name, component) =>
          ctx.effect(() =>
            ctx.slots.inject(name, () =>
              ctx.slots.register(
                {
                  name,
                  key: PROVIDER,
                  inject: (sessionId) => ({ ownerSession: sessionId }),
                },
                component,
              ),
            ),
          );
        slot('sidebar.right.pane.tab.title', Title);
        ctx.effect(() =>
          ctx.sidebarRightTabs.register({
            id: PROVIDER,
            kind: KIND,
            multiple: true,
            keepMounted: true,
            title: () => 'Browser',
          }),
        );
        slot('sidebar.right.pane.tab', Body);
        ctx.effect(() => {
          if (window.__dshSidebarControl)
            throw new Error('Sidebar control already loaded');
          window.__dshSidebarControl = pages.api;
          const disposers = [
            sidebar.mounted.subscribe?.(layout.request),
            sidebar.openTabs?.subscribe?.(layout.request),
          ].filter(Boolean);
          const observer = new MutationObserver(() => layout.request());
          observer.observe(document.body, {
            subtree: true,
            attributes: true,
            attributeFilter: [
              'hidden',
              'data-sidebar-right-open',
              'aria-selected',
            ],
          });
          const onEvent = () => layout.request();
          for (const event of ['resize', 'pointermove', 'scroll'])
            window.addEventListener(event, onEvent, {
              passive: true,
              capture: true,
            });
          document.addEventListener('transitionrun', layout.animate, true);
          return async () => {
            layout.stop();
            observer.disconnect();
            disposers.forEach((fn) => fn());
            for (const event of ['resize', 'pointermove', 'scroll'])
              window.removeEventListener(event, onEvent, true);
            document.removeEventListener('transitionrun', layout.animate, true);
            if (window.__dshSidebarControl === pages.api)
              delete window.__dshSidebarControl;
            await pages.dispose();
          };
        });
      },
    };
  },
});
