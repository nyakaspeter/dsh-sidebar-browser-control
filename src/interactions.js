import { setTimeout as delay } from 'node:timers/promises';
export const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const named = {
  Enter: ['Enter', 13],
  Tab: ['Tab', 9],
  Escape: ['Escape', 27],
  Backspace: ['Backspace', 8],
  Delete: ['Delete', 46],
  Insert: ['Insert', 45],
  Space: ['Space', 32],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowUp: ['ArrowUp', 38],
  ArrowRight: ['ArrowRight', 39],
  ArrowDown: ['ArrowDown', 40],
  Home: ['Home', 36],
  End: ['End', 35],
  PageUp: ['PageUp', 33],
  PageDown: ['PageDown', 34],
};
for (let i = 1; i <= 12; i++) named[`F${i}`] = [`F${i}`, 111 + i];
// US layout: unshifted punctuation, and what Shift turns each key into.
const punctuation = {
  '`': ['Backquote', 192],
  '-': ['Minus', 189],
  '=': ['Equal', 187],
  '[': ['BracketLeft', 219],
  ']': ['BracketRight', 221],
  '\\': ['Backslash', 220],
  ';': ['Semicolon', 186],
  "'": ['Quote', 222],
  ',': ['Comma', 188],
  '.': ['Period', 190],
  '/': ['Slash', 191],
};
const SHIFTED = Object.fromEntries(
  [...'`~1!2@3#4$5%6^7&8*9(0)-_=+[{]}\\|;:\'",<.>/?'.matchAll(/(.)(.)/gs)].map(
    ([, base, shifted]) => [base, shifted],
  ),
);
const UNSHIFTED = Object.fromEntries(
  Object.entries(SHIFTED).map(([base, shifted]) => [shifted, base]),
);
const shiftedText = (key) =>
  /^[a-z]$/i.test(key) ? key.toUpperCase() : (SHIFTED[key] ?? key);
export function keySpec(key) {
  if (named[key])
    return {
      key: key === 'Space' ? ' ' : key,
      code: named[key][0],
      windowsVirtualKeyCode: named[key][1],
    };
  if (/^[a-zA-Z]$/.test(key))
    return {
      key,
      code: `Key${key.toUpperCase()}`,
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
    };
  if (/^[0-9]$/.test(key))
    return {
      key,
      code: `Digit${key}`,
      windowsVirtualKeyCode: key.charCodeAt(0),
    };
  // A shifted symbol is typed with its base key; the caller adds Shift.
  const base = UNSHIFTED[key] ?? key;
  if (punctuation[base] || /^[0-9]$/.test(base))
    return {
      key,
      code: punctuation[base]?.[0] ?? `Digit${base}`,
      windowsVirtualKeyCode: punctuation[base]?.[1] ?? base.charCodeAt(0),
      ...(UNSHIFTED[key] && { shift: true }),
    };
  throw Error(
    'Unsupported key. Use letters, digits, punctuation, Enter, Tab, Escape, Space, arrows, Home/End, PageUp/Down, Backspace, Delete, Insert or F1–F12. Type longer text with type mode insert.',
  );
}
// Validates a wait deadline and combines it with the caller's signal.
export function deadline(timeoutMs = 5000, signal) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    throw Error('timeoutMs must be 1–10000.');
  const bound = AbortSignal.timeout(timeoutMs);
  return { bound, combined: signal ? AbortSignal.any([signal, bound]) : bound };
}
// Arguments arrive validated by args.js. page.call(method, params, signal,
// sessionId) sends to the page or to an out-of-process frame session; page.dom
// routes frame refs to isolated worlds and resolves points to { x, y, session };
// page.insertText types as real text input through the guest.
export async function interact(page, args, signal) {
  const call = (method, params, s = signal, session) =>
    page.call(method, params, s, session);
  const dom = (action, a = args, s = signal) => page.dom(action, a, s);
  const point = (a) =>
    a.ref || a.selector ? dom('point', a) : { x: a.x, y: a.y };
  if (args.action === 'scroll') return dom('scroll');
  if (args.action === 'wait') {
    const { bound, combined } = deadline(args.timeoutMs, signal);
    try {
      while (true) {
        if (await dom('wait', args, combined)) return { matched: true };
        await delay(100, undefined, { signal: combined });
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (bound.aborted)
        return {
          matched: false,
          code: 'WAIT_TIMEOUT',
          message:
            'Condition not met within the deadline. Read the page before deciding what to do next.',
        };
      throw error;
    }
  }
  if (args.action === 'type') {
    // insert types at the focused field as real text input; fill on a
    // contenteditable selects its content so the insertion replaces it.
    const result = await dom(args.mode === 'insert' ? 'focus' : 'type');
    if (args.mode !== 'insert' && !result.insert) return result;
    await page.insertText(args.text, signal);
    return { updated: true };
  }
  if (args.action === 'press') {
    const { shift, ...spec } = keySpec(args.key);
    const modifiers = (args.modifiers ?? []).reduce(
      (v, n) => v | MODIFIERS[n],
      shift ? 8 : 0,
    );
    if (args.ref || args.selector) await dom('focus');
    const text =
      spec.key.length === 1 && (modifiers & ~8) === 0
        ? modifiers & 8
          ? shiftedText(spec.key)
          : spec.key
        : spec.key === 'Enter'
          ? '\r'
          : undefined;
    try {
      await call('Input.dispatchKeyEvent', {
        type: 'keyDown',
        ...spec,
        modifiers,
        ...(text && { text }),
      });
    } finally {
      await call(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', ...spec, modifiers },
        AbortSignal.timeout(1000),
      );
    }
    return { pressed: args.key };
  }
  if (args.action === 'drag') return drag(page, args, point, signal);
  const { session, ...at } = await point(args);
  const mouse = (params, s) =>
    call('Input.dispatchMouseEvent', { ...params, ...at }, s, session);
  if (args.action === 'hover') {
    await mouse({ type: 'mouseMoved' });
    return { hovered: true };
  }
  const button = args.button ?? 'left',
    count = args.clickCount ?? 1;
  let released = true;
  try {
    await mouse({ type: 'mouseMoved' });
    for (let clickCount = 1; clickCount <= count; clickCount++) {
      released = false;
      await mouse({ type: 'mousePressed', button, clickCount });
      await mouse({ type: 'mouseReleased', button, clickCount });
      released = true;
    }
  } finally {
    if (!released)
      await mouse(
        { type: 'mouseReleased', button, clickCount: count },
        AbortSignal.timeout(1000),
      );
  }
  return { [args.action]: true };
}
// Native HTML5 drag-and-drop needs drag events; mouse-driven drags (sliders,
// maps, JS libraries) only need mouse moves. Interception tells them apart.
async function drag(page, args, point, signal) {
  const from = await point(args);
  const to = await point({
    ref: args.toRef,
    selector: args.toSelector,
    x: args.toX,
    y: args.toY,
    scroll: false,
  });
  if (from.session !== to.session)
    throw Error('Drag between different cross-origin frames is not supported.');
  const session = from.session;
  const call = (method, params, s = signal) =>
    page.call(method, params, s, session);
  const at = ({ x, y }) => ({ x, y });
  let data = null,
    pressed = false;
  const off = page.on('Input.dragIntercepted', (event, sid) => {
    if (sid === session) data = event.data;
  });
  try {
    await call('Input.setInterceptDrags', { enabled: true }).catch(() => {});
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at(from) });
    await call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      ...at(from),
    });
    pressed = true;
    for (let i = 1; i <= 10; i++)
      await call('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        button: 'left',
        buttons: 1,
        x: from.x + ((to.x - from.x) * i) / 10,
        y: from.y + ((to.y - from.y) * i) / 10,
      });
    await delay(50, undefined, { signal });
    if (data)
      for (const type of ['dragEnter', 'dragOver', 'drop'])
        await call('Input.dispatchDragEvent', { type, ...at(to), data });
    await call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      ...at(to),
    });
    pressed = false;
    return { dragged: true, ...(data && { html5: true }) };
  } finally {
    off();
    if (pressed)
      await call(
        'Input.dispatchMouseEvent',
        { type: 'mouseReleased', button: 'left', clickCount: 1, ...at(to) },
        AbortSignal.timeout(1000),
      ).catch(() => {});
    await call(
      'Input.setInterceptDrags',
      { enabled: false },
      AbortSignal.timeout(1000),
    ).catch(() => {});
  }
}
