import { setTimeout as delay } from 'node:timers/promises';
import { domExpression } from './page-dom.js';
const named = {
  Enter: ['Enter', 13],
  Tab: ['Tab', 9],
  Escape: ['Escape', 27],
  Backspace: ['Backspace', 8],
  Delete: ['Delete', 46],
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
  throw Error(
    'Unsupported key. Use letters, digits, Enter, Tab, Escape, Space, arrows, Home/End, PageUp/Down, Backspace or Delete.',
  );
}
export async function interact(page, args, signal) {
  const call = (method, params, s = signal) => page.call(method, params, s);
  // The controller supplies dom() to route frame refs and use isolated worlds.
  const dom = (action, a = args, s = signal) =>
    page.dom
      ? page.dom(action, a, s)
      : page.evaluate(domExpression(action, a), s);
  const point = async (a) => {
    if (a.ref || a.selector) return dom('point', a);
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || a.x < 0 || a.y < 0)
      throw Error('Provide ref/selector or nonnegative x and y coordinates.');
    return { x: a.x, y: a.y };
  };
  if (args.action === 'scroll') return dom('scroll');
  if (args.action === 'wait') {
    if (
      !['visible', 'hidden', 'text', 'url', 'ready'].includes(
        args.condition ?? 'visible',
      )
    )
      throw Error('Unknown wait condition.');
    if (['text', 'url'].includes(args.condition) && !args.text)
      throw Error('text is required for this wait condition.');
    const timeoutMs = args.timeoutMs ?? 5000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
      throw Error('timeoutMs must be 1–10000.');
    const bound = AbortSignal.timeout(timeoutMs),
      combined = signal ? AbortSignal.any([signal, bound]) : bound;
    try {
      while (true) {
        if (
          await dom(
            'wait',
            { ...args, condition: args.condition ?? 'visible' },
            combined,
          )
        )
          return { matched: true };
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
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });
  if (args.action === 'type') return dom('type');
  if (args.action === 'press') {
    const spec = keySpec(args.key ?? ''),
      hold = args.durationMs ?? 0;
    if (!Number.isFinite(hold) || hold < 0 || hold > 2000)
      throw Error('durationMs must be 0–2000.');
    const names = (args.modifiers ?? '').split('+').filter(Boolean),
      flags = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
    if (names.some((n) => !flags[n]))
      throw Error('modifiers must use Alt, Control, Meta, Shift joined by +.');
    const modifiers = names.reduce((v, n) => v | flags[n], 0);
    if (args.ref || args.selector) await dom('focus');
    try {
      await call('Input.dispatchKeyEvent', {
        type: 'keyDown',
        ...spec,
        modifiers,
        ...((modifiers === 0 || modifiers === 8) && spec.key.length === 1
          ? { text: modifiers === 8 ? spec.key.toUpperCase() : spec.key }
          : spec.key === 'Enter'
            ? { text: '\r' }
            : {}),
      });
      if (hold) await delay(hold, undefined, { signal });
    } finally {
      await call(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', ...spec, modifiers },
        AbortSignal.timeout(1000),
      );
    }
    return { pressed: args.key };
  }
  const at = await point(args);
  if (args.action === 'hover') {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
    return { hovered: true };
  }
  const button = args.button ?? 'left',
    count = args.clickCount ?? 1;
  if (!['left', 'right', 'middle'].includes(button) || ![1, 2].includes(count))
    throw Error('button must be left/right/middle and clickCount 1 or 2.');
  let released = true;
  try {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
    for (let clickCount = 1; clickCount <= count; clickCount++) {
      released = false;
      await call('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button,
        clickCount,
        ...at,
      });
      await call('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        button,
        clickCount,
        ...at,
      });
      released = true;
    }
  } finally {
    if (!released)
      await call(
        'Input.dispatchMouseEvent',
        { type: 'mouseReleased', button, clickCount: count, ...at },
        AbortSignal.timeout(1000),
      );
  }
  return { [args.action]: true };
}
