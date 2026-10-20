/* Persistent webviews with a session-scoped DSH sidebar presentation. */
window.__ModuleLoader__.load({
  id: 'dsh-sidebar-browser-control',
  factory: (require) => {
    const React = require('react');
    const icons = require('@deepseek-ai/dsh-client-ui-primitives');
    return {
      inject: ['sidebarRight', 'sidebarRightTabs', 'slots'],
      apply(ctx) {
        const sidebar = ctx.sidebarRight,
          bridge = window.dshDesktop?.browser;
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
        if (missing.length) {
          ctx.effect(() => {
            const api = {
              status: () => ({
                version: 2,
                build: '0.5.3',
                compatibilityError: missing.join(', '),
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
        // Use DSH's settings transport and plugin-card slot; no application bundle patching.
        ctx.inject?.(['configForms'], (settings) => {
          const directory = settings.configForms.describe();
          function CookieSettings(props) {
            const [state, setState] = React.useState(() =>
              props.scope.getSnapshot(),
            );
            const [saving, setSaving] = React.useState(false),
              [error, setError] = React.useState('');
            React.useEffect(
              () =>
                props.scope.subscribe(() =>
                  setState(props.scope.getSnapshot()),
                ),
              [props.scope],
            );
            if (props.view === 'summary')
              return 'Background browser control and cookie preferences.';
            return React.createElement(
              'div',
              { style: { padding: '12px', display: 'grid', gap: '10px' } },
              React.createElement(
                'label',
                {
                  style: { display: 'flex', gap: '10px', alignItems: 'center' },
                },
                React.createElement('input', {
                  type: 'checkbox',
                  role: 'switch',
                  'aria-label': 'Automatically handle cookie consent',
                  checked: state.value?.autoCookieConsent !== false,
                  disabled:
                    saving || state.status !== 'ready' || !state.writable,
                  onChange: async (e) => {
                    const value = e.target.checked;
                    setSaving(true);
                    setError('');
                    try {
                      if (!(await props.scope.set('autoCookieConsent', value)))
                        setError('Could not save. Please try again.');
                    } catch {
                      setError('Could not save. Please try again.');
                    } finally {
                      setSaving(false);
                    }
                  },
                }),
                'Automatically handle cookie consent',
              ),
              React.createElement(
                'p',
                null,
                'Reject optional cookies and preserve existing choices. When off, agents leave banners alone unless you ask. Changes apply to the next browser open/read/status call.',
              ),
              error ? React.createElement('p', { role: 'alert' }, error) : null,
            );
          }
          let unregister, namespace;
          const sync = () => {
            const ns = directory
              .getSnapshot()
              .view?.namespaces.find(
                (n) => n.value && Object.hasOwn(n.value, 'autoCookieConsent'),
              )?.ns;
            if (ns === namespace) return;
            unregister?.();
            namespace = ns;
            if (ns)
              unregister = settings.slots.inject('plugins.bundle.config', () =>
                settings.slots.register(
                  {
                    name: 'plugins.bundle.config',
                    key: 'dsh-sidebar-browser-control',
                    inject: () => ({ scope: settings.configForms.get(ns) }),
                  },
                  CookieSettings,
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
        const owned = new Map(),
          panels = new Map(),
          kind = 'agent-browser',
          provider = 'dsh-sidebar-browser-control';
        const keyFor = (session, id) => JSON.stringify([session, id]);
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
          if (!view)
            throw new Error(
              'Native browser tab has no running page. Open or restore it in DSH first; do not retry in a loop.',
            );
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
          const page =
            owned.get(keyFor(session, id)) ?? nativePage(session, id);
          if (!page || page.session !== session)
            throw new Error('Unknown tab or tab belongs to another chat');
          if (
            page.sidebarTabId &&
            !sidebar.tabsIn(session).some((t) => t.id === page.sidebarTabId)
          )
            throw new Error('Sidebar tab has been closed');
          return page;
        };
        const release = async (id) => {
          const page = owned.get(id);
          if (!page) return;
          owned.delete(id);
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
        // The webview never changes DOM parents: Electron can destroy a guest on reparenting.
        // Transparent parked pages retain a composited viewport for background screenshots.
        const layout = () => {
          for (const [key, page] of owned) {
            const id = page.sidebarTabId;
            if (id && !sidebar.tabsIn(page.session).some((t) => t.id === id)) {
              void release(key).catch(console.error);
              continue;
            }
            const panel = panels.get(key),
              rect = panel?.getBoundingClientRect();
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
                : {
                    left: '0px',
                    top: '0px',
                    width: '1100px',
                    height: '760px',
                    pointerEvents: 'none',
                    opacity: '0',
                  },
            );
          }
        };
        let layoutFrame = null,
          animateUntil = 0;
        const requestLayout = () => {
          if (disposed || !owned.size || layoutFrame !== null) return;
          layoutFrame = requestAnimationFrame(() => {
            layoutFrame = null;
            layout();
            if (Date.now() < animateUntil && panels.size) requestLayout();
          });
        };
        const api = {
          version: 2,
          build: '0.5.3',
          status() {
            return {
              version: 2,
              build: this.build,
              visibleSession: sidebar.mounted.getSnapshot() ?? null,
              tabs: owned.size,
            };
          },
          async open(session, value, background = true) {
            check(session);
            const url = validURL(value);
            if (!background && sidebar.mounted.getSnapshot() === session) {
              const before = new Set(sidebar.tabsIn(session).map((t) => t.id));
              sidebar.openTabIn(session, 'browser', { params: { url } });
              const tab = sidebar
                .tabsIn(session)
                .find((t) => t.kind === 'browser' && !before.has(t.id));
              if (!tab)
                throw new Error('DSH did not create a native browser tab');
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
            const before = new Set(sidebar.tabsIn(session).map((t) => t.id));
            if (!background)
              sidebar.openTabIn(session, kind, { params: { url } });
            const tab = background
              ? { id: `background-${++backgroundSequence}` }
              : sidebar
                  .tabsIn(session)
                  .find((t) => t.kind === kind && !before.has(t.id));
            if (!tab)
              throw new Error(
                'DSH did not create a sidebar tab for the calling chat',
              );
            const key = keyFor(session, tab.id);
            let reservation, container;
            try {
              reservation = await bridge.acquire(
                `dsh-sidebar-control:${session}`,
              );
              if (disposed) throw new Error('Plugin was unloaded');
              container = document.createElement('div');
              Object.assign(container.style, {
                position: 'fixed',
                left: '0px',
                top: '0',
                width: '1100px',
                height: '760px',
                zIndex: '20',
                opacity: '0',
                pointerEvents: 'none',
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
                  cleanup();
                  reject(new Error('Webview initialization timed out'));
                }, 8000);
                const loaded = () => {
                  cleanup();
                  resolve();
                };
                const cleanup = () => {
                  clearTimeout(timer);
                  view.removeEventListener('dom-ready', loaded);
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
              };
              owned.set(key, page);
              container.append(view);
              document.body.append(container);
              await ready;
              page.unsubscribe = bridge.onOpenRequested?.(
                reservation.lease,
                (request) => {
                  void api
                    .open(session, request.url ?? request, !page.sidebarTabId)
                    .catch(console.error);
                },
              );
              void view.loadURL(url).catch((error) => {
                page.loadError = error.message;
              });
              layout();
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
          },
          list(session) {
            check(session);
            return [
              ...[...owned]
                .filter(([, p]) => p.session === session)
                .map(([, p]) => ({
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
                    background:
                      sidebar.mounted.getSnapshot() !== session ||
                      sidebar.active()?.id !== t.id ||
                      !sidebar.isExpanded(),
                  };
                }),
            ];
          },
          focus(session, id) {
            check(session);
            if (nativeTab(session, id)) {
              sidebar.actionsFor(session).focusTab(session, id);
              sidebar.actionsFor(session).setExpanded(session, true);
              return {
                tabId: id,
                native: true,
                visible: sidebar.mounted.getSnapshot() === session,
              };
            }
            const page = get(session, id);
            if (!page.sidebarTabId) {
              const before = new Set(sidebar.tabsIn(session).map((t) => t.id));
              sidebar.openTabIn(session, kind, {
                params: { url: page.view.getURL() },
              });
              const tab = sidebar
                .tabsIn(session)
                .find((t) => t.kind === kind && !before.has(t.id));
              if (!tab)
                throw new Error('DSH did not create a sidebar presentation');
              page.sidebarTabId = tab.id;
            }
            sidebar.actionsFor(session).focusTab(session, page.sidebarTabId);
            layout();
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
            layout();
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
          visible(session) {
            return sidebar.mounted.getSnapshot() === session;
          },
        };
        const pageFor = (session, tabId) =>
          [...owned.values()].find(
            (p) => p.session === session && p.sidebarTabId === tabId,
          );
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
              const page = pageFor(props.ownerSession, tab.id);
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
            return watchPage(pageFor(props.ownerSession, tab.id), update);
          }, [props.ownerSession, tab.id]);
          return React.createElement('span', { title }, title);
        }
        function Body(props) {
          const { tab } = props.useTabInfo();
          const match = pageFor(props.ownerSession, tab.id);
          const key = keyFor(props.ownerSession, match?.tabId ?? tab.id);
          const panel = React.useRef(null),
            [url, setUrl] = React.useState(''),
            [navigation, setNavigation] = React.useState({
              back: false,
              forward: false,
            });
          React.useLayoutEffect(() => {
            panels.set(key, panel.current);
            const observer = new ResizeObserver(() => requestLayout());
            observer.observe(panel.current);
            requestLayout();
            return () => {
              observer.disconnect();
              panels.delete(key);
              requestLayout();
            };
          }, [key]);
          React.useEffect(() => {
            const update = () => {
              const p = owned.get(key);
              if (p) {
                if (
                  document.activeElement?.dataset.sidebarControlAddress !==
                  tab.id
                )
                  setUrl(p.view.getURL());
                setNavigation({
                  back: p.view.canGoBack(),
                  forward: p.view.canGoForward(),
                });
              }
            };
            update();
            return watchPage(owned.get(key), update);
          }, [key]);
          const page = () => owned.get(key);
          const button = (label, icon, fn, disabled = false, type = 'button') =>
            React.createElement(
              'button',
              {
                className: 'dsh-agent-browser-tool',
                onClick: fn,
                type,
                disabled,
                'aria-label': label,
                title: label,
              },
              React.createElement(icons[icon]),
            );
          return React.createElement(
            'div',
            { className: 'dsh-agent-browser-root' },
            React.createElement(
              'form',
              {
                className: 'dsh-agent-browser-toolbar',
                onSubmit: (e) => {
                  e.preventDefault();
                  const p = page();
                  if (p)
                    void p.view.loadURL(validURL(url)).catch(console.error);
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
              React.createElement(
                'div',
                { className: 'dsh-agent-browser-address-box' },
                React.createElement('input', {
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
                      validURL(p.view.getURL()),
                      '_blank',
                      'noopener,noreferrer',
                    );
                },
                !page(),
              ),
            ),
            React.createElement(
              'div',
              { ref: panel, style: { flex: 1, minHeight: 0 } },
              owned.has(key)
                ? null
                : 'This browser page is no longer running. Ask the agent to open a new tab.',
            ),
          );
        }
        ctx.effect(() => {
          const style = document.createElement('style');
          style.textContent = `
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
          document.body.append(style);
          return () => style.remove();
        });
        ctx.effect(() =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab.title',
                key: provider,
                inject: (sessionId) => ({ ownerSession: sessionId }),
              },
              Title,
            ),
          ),
        );
        ctx.effect(() =>
          ctx.sidebarRightTabs.register({
            id: provider,
            kind,
            multiple: true,
            keepMounted: true,
            title: () => 'Browser',
          }),
        );
        ctx.effect(() =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: provider,
                inject: (sessionId) => ({ ownerSession: sessionId }),
              },
              Body,
            ),
          ),
        );
        ctx.effect(() => {
          if (window.__dshSidebarControl)
            throw new Error('Sidebar control already loaded');
          window.__dshSidebarControl = api;
          const disposers = [
            sidebar.mounted.subscribe?.(requestLayout),
            sidebar.openTabs?.subscribe?.(requestLayout),
          ].filter(Boolean);
          const observer = new MutationObserver(requestLayout);
          observer.observe(document.body, {
            subtree: true,
            attributes: true,
            attributeFilter: [
              'hidden',
              'data-sidebar-right-open',
              'aria-selected',
            ],
          });
          const transition = () => {
            if (panels.size) {
              animateUntil = Date.now() + 500;
              requestLayout();
            }
          };
          for (const event of ['resize', 'pointermove', 'scroll'])
            window.addEventListener(event, requestLayout, {
              passive: true,
              capture: true,
            });
          document.addEventListener('transitionrun', transition, true);
          return async () => {
            disposed = true;
            if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
            observer.disconnect();
            disposers.forEach((fn) => fn());
            for (const event of ['resize', 'pointermove', 'scroll'])
              window.removeEventListener(event, requestLayout, true);
            document.removeEventListener('transitionrun', transition, true);
            if (window.__dshSidebarControl === api)
              delete window.__dshSidebarControl;
            await Promise.all([...owned.keys()].map(release));
            panels.clear();
          };
        });
      },
    };
  },
});
