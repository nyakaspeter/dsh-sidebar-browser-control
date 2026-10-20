// Serialized into the page. References expire on a new read or navigation.
function pageDOM(action, args) {
  const slot = '__dshBrowserElements';
  const roots = [],
    frames = [];
  function walk(root, offset = { x: 0, y: 0 }) {
    roots.push({ root, offset });
    for (const e of root.querySelectorAll('*')) {
      if (e.shadowRoot) walk(e.shadowRoot, offset);
      if (e.tagName === 'IFRAME') {
        try {
          if (!e.contentDocument) throw Error();
          const r = e.getBoundingClientRect();
          walk(e.contentDocument, {
            x: offset.x + r.left + e.clientLeft,
            y: offset.y + r.top + e.clientTop,
          });
        } catch {
          frames.push({ src: e.src, name: e.name || undefined });
        }
      }
    }
  }
  walk(document);
  const visible = (e) => {
    const r = e.getBoundingClientRect(),
      s = e.ownerDocument.defaultView.getComputedStyle(e);
    return (
      r.width > 0 &&
      r.height > 0 &&
      s.visibility !== 'hidden' &&
      s.display !== 'none'
    );
  };
  function target() {
    let e;
    if (args.ref) {
      e = globalThis[slot]?.refs.get(args.ref);
      if (!e?.isConnected)
        throw Error('Stale element reference; read the page again.');
    } else if (args.selector) {
      const found = roots.flatMap(({ root }) => [
        ...root.querySelectorAll(args.selector),
      ]);
      if (found.length !== 1)
        throw Error(
          `Selector matched ${found.length} elements; use read references to disambiguate.`,
        );
      e = found[0];
    } else throw Error('Provide ref or selector.');
    return e;
  }
  const CONTROLS =
    'a,button,input,textarea,select,[role],[contenteditable="true"],summary';
  // Compact control record; the host turns it into one text line.
  function describe(e, ref, full) {
    const kinds = {
      A: 'link',
      BUTTON: 'button',
      SELECT: 'select',
      TEXTAREA: 'textbox',
      SUMMARY: 'summary',
    };
    const inputs = {
      checkbox: 'checkbox',
      radio: 'radio',
      submit: 'button',
      button: 'button',
      reset: 'button',
      image: 'button',
      range: 'slider',
      file: 'file',
    };
    const kind =
      e.getAttribute('role') ||
      kinds[e.tagName] ||
      (e.tagName === 'INPUT'
        ? (inputs[e.type] ?? 'textbox')
        : e.isContentEditable
          ? 'textbox'
          : e.tagName.toLowerCase());
    const label = (
      e.getAttribute('aria-label') ||
      [...(e.labels ?? [])].map((l) => l.innerText).join(' ') ||
      e.innerText ||
      e.getAttribute('placeholder') ||
      e.getAttribute('title') ||
      e.getAttribute('alt') ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, full ? 200 : 80);
    const item = { ref, kind };
    if (label) item.label = label;
    if (kind === 'textbox' && e.type && !['text', 'textarea'].includes(e.type))
      item.inputType = e.type;
    if (e.disabled) item.disabled = true;
    if (
      typeof e.checked === 'boolean' &&
      ['checkbox', 'radio'].includes(e.type)
    )
      item.checked = e.checked;
    if (
      typeof e.value === 'string' &&
      e.value &&
      e.type !== 'password' &&
      !['checkbox', 'radio', 'submit', 'button'].includes(e.type) &&
      e.tagName !== 'BUTTON'
    )
      item.value = e.value.slice(0, full ? 300 : 100);
    const href = e.tagName === 'A' ? e.getAttribute('href') && e.href : '';
    if (href && !href.startsWith('javascript:')) {
      const u = new URL(href);
      item.href =
        u.origin === location.origin ? u.pathname + u.search + u.hash : href;
    }
    if (e.tagName === 'SELECT')
      item.options = [...e.options]
        .slice(0, full ? 50 : 12)
        .map((o) => (o.selected ? '*' : '') + o.label);
    return item;
  }
  // Refs are r<read>.<n>: short, and a ref from an older read never resolves.
  function register(fresh) {
    const prev = globalThis[slot];
    if (fresh || !prev)
      globalThis[slot] = {
        epoch: (prev?.epoch ?? 0) + 1,
        next: 1,
        refs: new Map(),
        ids: new Map(),
      };
    const state = globalThis[slot];
    return (e) => {
      let ref = state.ids.get(e);
      if (ref) return ref;
      ref = `r${state.epoch}.${state.next++}`;
      state.refs.set(ref, e);
      state.ids.set(e, ref);
      return ref;
    };
  }
  if (action === 'read') {
    // Collects up to fixed caps; the host paginates across this frame and any
    // cross-origin frames read in their own isolated worlds.
    const scoped = args.ref || args.selector ? target() : null;
    const refFor = register(true);
    const full = args.detail === 'full',
      maxText = 400000,
      maxElements = 2000,
      frameOffset = args.frameOffset ?? { x: 0, y: 0 },
      viewport = args.viewport ?? { width: innerWidth, height: innerHeight };
    const readRoots = scoped
      ? [{ root: scoped, offset: { x: 0, y: 0 } }]
      : roots;
    const elements = [];
    let total = 0;
    for (const { root, offset } of readRoots) {
      for (const e of root.querySelectorAll(CONTROLS)) {
        if (!visible(e)) continue;
        const r = e.getBoundingClientRect(),
          x = offset.x + frameOffset.x,
          y = offset.y + frameOffset.y;
        const inViewport =
          r.bottom + y > 0 &&
          r.right + x > 0 &&
          r.top + y < viewport.height &&
          r.left + x < viewport.width;
        if (args.viewportOnly && !inViewport) continue;
        total++;
        if (elements.length >= maxElements) continue;
        elements.push(describe(e, refFor(e), full));
      }
    }
    // Text comes from the page's marked main region unless the whole page is
    // asked for; controls always cover the whole page.
    let main = null;
    if (!scoped && args.scope !== 'page' && !args.frameOffset) {
      main =
        [...document.querySelectorAll('main, [role="main"]')].find(visible) ??
        null;
      const articles = [...document.querySelectorAll('article')].filter(
        visible,
      );
      if (!main && articles.length === 1) main = articles[0];
      if (main && main.innerText.trim().length < 200) main = null;
    }
    const text = (
      main
        ? [main.innerText]
        : readRoots.map(
            ({ root }) =>
              root.body?.innerText ??
              root.innerText ??
              (root.host ? root.textContent : ''),
          )
    )
      .filter(Boolean)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      ...(main ? { scope: 'main' } : {}),
      text: text.slice(0, maxText),
      textLength: text.length,
      elements,
      total,
      ...(frames.length ? { inaccessibleFrames: frames } : {}),
    };
  }
  if (action === 'find') {
    // Controls whose label, value or link matches first, then the smallest
    // visible elements whose text matches. Refs join the latest read's refs.
    const query = String(args.query).toLowerCase();
    const refFor = register(false);
    const scored = [];
    for (const { root } of roots)
      for (const e of root.querySelectorAll(CONTROLS)) {
        if (!visible(e)) continue;
        const item = describe(e, '', false);
        const hay = [
          item.label,
          item.value,
          item.href,
          e.getAttribute('name'),
          e.id,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        const at = hay.indexOf(query);
        if (at < 0) continue;
        scored.push({
          e,
          score: item.label?.toLowerCase() === query ? 0 : at === 0 ? 1 : 2,
        });
      }
    scored.sort((a, b) => a.score - b.score);
    const found = scored
      .slice(0, 8)
      .map(({ e }) => describe(e, refFor(e), false));
    if (found.length < 8)
      for (const { root } of roots) {
        const walker = (root.ownerDocument ?? root).createTreeWalker(
          root,
          NodeFilter.SHOW_TEXT,
        );
        const seen = new Set();
        for (
          let n = walker.nextNode();
          n && found.length < 8;
          n = walker.nextNode()
        ) {
          if (!n.textContent.toLowerCase().includes(query)) continue;
          const e = n.parentElement;
          if (!e || seen.has(e) || e.closest(CONTROLS) || !visible(e)) continue;
          seen.add(e);
          found.push({
            ref: refFor(e),
            kind: 'text',
            label: e.innerText.replace(/\s+/g, ' ').trim().slice(0, 120),
          });
        }
      }
    return { url: location.href, found, inaccessible: frames.length > 0 };
  }
  if (action === 'wait') {
    if (args.condition === 'url')
      return location.href.includes(args.text ?? '');
    if (args.condition === 'text')
      return roots.some(({ root }) =>
        (root.body?.innerText ?? root.textContent ?? '').includes(
          args.text ?? '',
        ),
      );
    if (args.condition === 'ready') return document.readyState === 'complete';
    try {
      const e = target();
      return args.condition === 'hidden' ? !visible(e) : visible(e);
    } catch (error) {
      if (args.ref) throw error;
      if (/matched 0 elements/.test(error.message))
        return args.condition === 'hidden';
      throw error;
    }
  }
  if (action === 'scroll') {
    if (args.ref || args.selector) {
      const e = target();
      if (args.intoView) {
        e.scrollIntoView({ block: 'center', inline: 'nearest' });
        return { scrolledIntoView: true };
      }
      e.scrollBy(args.deltaX, args.deltaY);
      return { x: e.scrollLeft, y: e.scrollTop };
    }
    window.scrollBy(args.deltaX, args.deltaY);
    return { x: scrollX, y: scrollY };
  }
  const e = target(),
    win = e.ownerDocument.defaultView;
  // Returned by reference (returnByValue:false) for DOM.setFileInputFiles.
  if (action === 'fileInput') {
    if (!(e instanceof win.HTMLInputElement) || e.type !== 'file')
      throw Error('Target is not a file input.');
    if (e.disabled) throw Error('File input is disabled.');
    if ((args.count ?? 1) > 1 && !e.multiple)
      throw Error('This file input accepts only one file.');
    return e;
  }
  if (action === 'href') {
    const url = e.href || e.currentSrc || e.src || e.data;
    if (!url) throw Error('Target has no link or source URL.');
    return { url: String(url), download: e.download || undefined };
  }
  if (action === 'point' || action === 'focus' || action === 'rect') {
    if (args.scroll !== false)
      e.scrollIntoView({ block: 'center', inline: 'nearest' });
    if (action === 'focus') {
      e.focus();
      return {
        focused:
          e.ownerDocument.activeElement === e ||
          e.getRootNode().activeElement === e,
      };
    }
    if (!visible(e)) throw Error('Target is not visible.');
    const r = e.getBoundingClientRect();
    let x = action === 'rect' ? r.left : r.left + r.width / 2,
      y = action === 'rect' ? r.top : r.top + r.height / 2,
      w = win;
    while (w !== window) {
      const f = w.frameElement;
      f.scrollIntoView({ block: 'nearest' });
      const fr = f.getBoundingClientRect();
      x += fr.left + f.clientLeft;
      y += fr.top + f.clientTop;
      w = w.parent;
    }
    return action === 'rect'
      ? { x, y, width: r.width, height: r.height }
      : { x, y };
  }
  if (action === 'type') {
    if (e.disabled || e.readOnly) throw Error('Element is not editable.');
    const mode = args.mode ?? 'fill';
    if (mode === 'check') {
      if (
        !['checkbox', 'radio'].includes(e.type) ||
        typeof args.checked !== 'boolean'
      )
        throw Error('check requires a checkbox/radio and checked boolean.');
      if (e.checked !== args.checked) e.click();
      if (e.checked !== args.checked)
        throw Error('Checked state did not change.');
      return { checked: e.checked };
    }
    if (mode === 'select') {
      if (e.tagName !== 'SELECT')
        throw Error('select requires a select element.');
      const option =
        [...e.options].find((o) => o.value === args.text) ||
        [...e.options].find((o) => o.label === args.text);
      if (!option || option.disabled)
        throw Error('Enabled dropdown option not found.');
      e.value = option.value;
    } else if (mode === 'fill') {
      if (typeof args.text !== 'string') throw Error('fill requires text.');
      if (
        e instanceof win.HTMLInputElement ||
        e instanceof win.HTMLTextAreaElement
      ) {
        const proto =
          e instanceof win.HTMLInputElement
            ? win.HTMLInputElement.prototype
            : win.HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, args.text);
      } else if (e.isContentEditable) {
        // Rich editors keep their own model: select the content and let the
        // host insert the text as real input instead of rewriting the DOM.
        e.focus();
        const selection = e.ownerDocument.getSelection();
        selection.removeAllRanges();
        const range = e.ownerDocument.createRange();
        range.selectNodeContents(e);
        selection.addRange(range);
        return { insert: true };
      } else throw Error('Target is not an editable field.');
    } else throw Error('Unknown type mode.');
    e.dispatchEvent(new win.Event('input', { bubbles: true }));
    e.dispatchEvent(new win.Event('change', { bubbles: true }));
    return { updated: true };
  }
  throw Error('Unknown DOM action.');
}
export const domExpression = (action, args) =>
  `(${pageDOM.toString()})(${JSON.stringify(action)},${JSON.stringify(args)})`;
