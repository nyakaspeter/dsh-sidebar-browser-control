// Serialized into the page. References expire on a new read or navigation.
export function pageDOM(action, args) {
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
          frames.push({ src: e.src, accessible: false });
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
  if (action === 'read') {
    const scope = args.ref || args.selector ? target() : null;
    const epoch = crypto.randomUUID().slice(0, 8),
      refs = new Map();
    globalThis[slot] = { epoch, refs };
    const full = args.detail === 'full',
      maxText = full ? 40000 : 6000,
      maxElements = full ? 200 : 40;
    const textOffset = args.textOffset ?? 0,
      elementOffset = args.elementOffset ?? 0;
    if (
      !Number.isSafeInteger(textOffset) ||
      textOffset < 0 ||
      !Number.isSafeInteger(elementOffset) ||
      elementOffset < 0
    )
      throw Error('Read offsets must be nonnegative integers.');
    const readRoots = scope ? [{ root: scope, offset: { x: 0, y: 0 } }] : roots;
    const elements = [];
    let total = 0;
    for (const { root, offset } of readRoots) {
      for (const e of root.querySelectorAll(
        'a,button,input,textarea,select,[role],[contenteditable="true"],summary',
      )) {
        if (!visible(e)) continue;
        const r = e.getBoundingClientRect();
        const inViewport =
          r.bottom + offset.y > 0 &&
          r.right + offset.x > 0 &&
          r.top + offset.y < innerHeight &&
          r.left + offset.x < innerWidth;
        if (args.viewportOnly && !inViewport) continue;
        total++;
        if (total <= elementOffset || elements.length >= maxElements) continue;
        const ref = `r${epoch}-${elements.length + 1}`;
        refs.set(ref, e);
        elements.push({
          ref,
          tag: e.tagName.toLowerCase(),
          role: e.getAttribute('role') || undefined,
          label: (
            e.getAttribute('aria-label') ||
            [...(e.labels ?? [])].map((l) => l.innerText).join(' ') ||
            e.innerText ||
            e.getAttribute('placeholder') ||
            ''
          ).slice(0, full ? 200 : 120),
          type: e.type,
          disabled: e.disabled || undefined,
          checked: typeof e.checked === 'boolean' ? e.checked : undefined,
          value:
            e.type === 'password'
              ? undefined
              : typeof e.value === 'string'
                ? e.value.slice(0, full ? 500 : 200)
                : undefined,
          href: e.href,
          inViewport,
          options:
            e.tagName === 'SELECT'
              ? [...e.options]
                  .map((o) => ({
                    value: o.value,
                    label: o.label,
                    selected: o.selected,
                  }))
                  .slice(0, full ? 100 : 20)
              : undefined,
        });
      }
    }
    const text = readRoots
      .map(
        ({ root }) =>
          root.body?.innerText ??
          root.innerText ??
          (root.host ? root.textContent : ''),
      )
      .filter(Boolean)
      .join('\n');
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      text: text.slice(textOffset, textOffset + maxText),
      elements,
      truncated:
        text.length > textOffset + maxText ||
        total > elementOffset + maxElements,
      ...(text.length > textOffset + maxText ||
      total > elementOffset + maxElements
        ? {
            next: {
              textOffset: Math.min(text.length, textOffset + maxText),
              elementOffset: Math.min(total, elementOffset + maxElements),
            },
          }
        : {}),
      ...(frames.length ? { inaccessibleFrames: frames } : {}),
    };
  }
  if (action === 'wait') {
    if (args.condition === 'url')
      return location.href.includes(args.text ?? '');
    if (args.condition === 'text')
      return (document.body?.innerText ?? '').includes(args.text ?? '');
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
      e.scrollBy(args.deltaX ?? 0, args.deltaY ?? 600);
      return { x: e.scrollLeft, y: e.scrollTop };
    }
    window.scrollBy(args.deltaX ?? 0, args.deltaY ?? 600);
    return { x: scrollX, y: scrollY };
  }
  const e = target(),
    win = e.ownerDocument.defaultView;
  if (action === 'point' || action === 'focus') {
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
    let x = r.left + r.width / 2,
      y = r.top + r.height / 2,
      w = win;
    while (w !== window) {
      const f = w.frameElement;
      f.scrollIntoView({ block: 'nearest' });
      const fr = f.getBoundingClientRect();
      x += fr.left + f.clientLeft;
      y += fr.top + f.clientTop;
      w = w.parent;
    }
    return { x, y };
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
      } else if (e.isContentEditable) e.textContent = args.text;
      else throw Error('Target is not an editable field.');
    } else throw Error('Unknown type mode.');
    e.dispatchEvent(new win.Event('input', { bubbles: true }));
    e.dispatchEvent(new win.Event('change', { bubbles: true }));
    return { updated: true };
  }
  throw Error('Unknown DOM action.');
}
export const domExpression = (action, args) =>
  `(${pageDOM.toString()})(${JSON.stringify(action)},${JSON.stringify(args)})`;
