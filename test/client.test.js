import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(
  new URL('../src/client.js', import.meta.url),
  'utf8',
);
function setup(broken = false) {
  const nativeViews = new Map();
  const rows = new Map([
    ['A', []],
    ['B', []],
  ]);
  let id = 0;
  const calls = [],
    cleanups = [];
  const sidebar = {
    mounted: { getSnapshot: () => 'B' },
    active: () => undefined,
    isExpanded: () => true,
    actionsFor: (s) =>
      rows.has(s)
        ? {
            focusTab: (s, t) => calls.push(['focus', s, t]),
            setExpanded: (s, v) => calls.push(['expanded', s, v]),
          }
        : undefined,
    tabsIn: (s) => rows.get(s) ?? [],
    openTabIn(s, kind) {
      const id = `tab${rows.get(s).length + 1}`;
      rows.get(s).push({ id, kind });
      if (kind === 'browser') {
        const view = new Element();
        view.setAttribute('name', `native-${s}-${id}`);
        view.closest = (selector) => ({
          dataset: selector.includes('session')
            ? { sidebarRightSession: s }
            : { sidebarRightTab: id },
        });
        nativeViews.set(s + id, view);
      }
      calls.push(['open', s]);
    },
    closeIn(s, t) {
      rows.set(
        s,
        rows.get(s).filter((x) => x.id !== t),
      );
      calls.push(['close', s, t]);
    },
  };
  class Element extends EventTarget {
    style = {};
    dataset = {};
    attributes = new Map();
    children = [];
    isConnected = true;
    setAttribute(k, v) {
      this.attributes.set(k, v);
    }
    getAttribute(k) {
      return this.attributes.get(k);
    }
    append(child) {
      this.children.push(child);
      queueMicrotask(() => child.dispatchEvent(new Event('dom-ready')));
    }
    remove() {
      this.isConnected = false;
    }
    getURL() {
      return this.url ?? 'about:blank';
    }
    getTitle() {
      return 'test';
    }
    async loadURL(url) {
      this.url = url;
    }
  }
  const bridge = {
    acquire: async (session) => ({
      lease: `lease-${session}-${id}`,
      partition: session,
    }),
    release: async (lease) => calls.push(['release', lease]),
  };
  if (broken) delete bridge.acquire;
  const window = {
    addEventListener() {},
    removeEventListener() {},
    dshDesktop: { browser: bridge },
    __ModuleLoader__: {
      load: (d) =>
        d
          .factory(() => ({}))
          .apply({
            sidebarRight: sidebar,
            sidebarRightTabs: { register: () => () => {} },
            slots: { inject: () => () => {}, register: () => () => {} },
            effect: (fn) => cleanups.push(fn()),
          }),
    },
  };
  vm.runInNewContext(source, {
    window,
    document: {
      addEventListener() {},
      removeEventListener() {},
      querySelectorAll: () => [...nativeViews.values()],
      createElement: () => new Element(),
      body: new Element(),
    },
    URL,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    console,
  });
  return {
    api: window.__dshSidebarControl,
    calls,
    dispose: async () => {
      for (const c of cleanups.reverse()) await c?.();
    },
  };
}
test('background session owns page lifetime independently of selected chat', async () => {
  const { api, calls, dispose } = setup();
  try {
    const tab = await api.open('A', 'https://example.org', false);
    assert.equal(api.list('A').length, 1);
    assert.equal(api.list('B').length, 0);
    assert.ok(api.lease('A', tab.tabId));
    assert.throws(() => api.lease('B', tab.tabId), /another chat/);
    api.focus('A', tab.tabId);
    await api.close('A', tab.tabId);
    assert.equal(api.list('A').length, 0);
    assert.equal(api.status().visibleSession, 'B');
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['open', 'focus', 'release', 'close'],
    );
  } finally {
    await dispose();
  }
});
test('unknown sessions and invalid URLs cannot create pages', async () => {
  const { api, dispose } = setup();
  try {
    await assert.rejects(
      api.open('missing', 'https://example.org'),
      /not loaded/,
    );
    await assert.rejects(api.open('A', 'file:///etc/passwd'), /HTTP/);
  } finally {
    await dispose();
  }
});
test('plugin disposal releases every leased webview', async () => {
  const { api, calls, dispose } = setup();
  await api.open('A', 'https://example.org');
  await api.open('B', 'https://example.org');
  await dispose();
  assert.equal(calls.filter((c) => c[0] === 'release').length, 2);
});

test('identical tab IDs in different chats never collide', async () => {
  const { api, dispose } = setup();
  try {
    const a = await api.open('A', 'https://a.example', false);
    const b = await api.open('B', 'https://b.example', false);
    assert.equal(a.tabId, b.tabId);
    assert.equal(api.list('A')[0].native, false);
    assert.equal(api.list('B')[0].native, true);
    await api.close('A', a.tabId);
    assert.equal(api.list('B').length, 1);
  } finally {
    await dispose();
  }
});

test('invisible tabs never open sidebar; focus presents the same guest with a stable ID', async () => {
  const { api, calls, dispose } = setup();
  try {
    const tab = await api.open('B', 'https://example.org');
    const lease = api.lease('B', tab.tabId);
    assert.equal(calls.length, 0);
    assert.equal(api.list('B')[0].background, true);
    api.focus('B', tab.tabId);
    assert.equal(api.lease('B', tab.tabId), lease);
    assert.equal(api.list('B')[0].background, false);
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['open', 'focus'],
    );
    await api.close('B', tab.tabId);
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['open', 'focus', 'release', 'close'],
    );
  } finally {
    await dispose();
  }
});
test('closing an invisible tab never touches sidebar state', async () => {
  const { api, calls, dispose } = setup();
  try {
    const tab = await api.open('B', 'https://example.org');
    await api.close('B', tab.tabId);
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['release'],
    );
    assert.equal(api.list('B').length, 0);
  } finally {
    await dispose();
  }
});
test('hide preserves the running guest and can reveal it again', async () => {
  const { api, dispose } = setup();
  try {
    const tab = await api.open('A', 'https://example.org'),
      lease = api.lease('A', tab.tabId);
    api.focus('A', tab.tabId);
    api.hide('A', tab.tabId);
    assert.equal(api.list('A')[0].background, true);
    assert.equal(api.lease('A', tab.tabId), lease);
    api.focus('A', tab.tabId);
    assert.equal(api.lease('A', tab.tabId), lease);
    assert.equal(api.list('A')[0].background, false);
  } finally {
    await dispose();
  }
});

test('missing DSH bridge methods produce an explicit compatibility status', async () => {
  const { api, dispose } = setup(true);
  try {
    assert.match(api.status().compatibilityError, /browser.acquire/);
    assert.equal(api.open, undefined);
  } finally {
    await dispose();
  }
});

test('native pages retain DSH ownership on plugin disposal', async () => {
  const { api, calls, dispose } = setup();
  const tab = await api.open('B', 'https://example.org', false);
  assert.equal(api.list('B')[0].native, true);
  assert.match(api.lease('B', tab.tabId), /^native-B/);
  assert.throws(() => api.lease('A', tab.tabId), /Unknown tab/);
  await dispose();
  assert.equal(
    calls.some((c) => c[0] === 'release'),
    false,
  );
});
