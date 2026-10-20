// The public tool schema is deliberately small (it is sent with every model
// request). This module maps it onto the internal arguments used by the
// controller, interactions and page DOM code, which trust it to be valid.
import { MODIFIERS } from './interactions.js';
const ACTIONS = [
  'help',
  'status',
  'open',
  'list',
  'focus',
  'hide',
  'close',
  'navigate',
  'read',
  'find',
  'click',
  'hover',
  'drag',
  'type',
  'press',
  'scroll',
  'wait',
  'dialog',
  'screenshot',
  'evaluate',
  'upload',
  'download',
  'logs',
];
const TAB_FREE = ['help', 'status', 'open', 'list'];

export const PARAMETERS = {
  action: { type: 'string', required: true, enum: ACTIONS },
  tabId: { type: 'string', description: 'From open/list' },
  url: { type: 'string', description: 'HTTP(S) URL: open, navigate, download' },
  target: {
    type: 'string',
    description: 'Ref from read/find (r3.12), CSS selector, or "x,y"',
  },
  text: {
    type: 'string',
    description:
      'Text to type/wait for, option, key combo, JS, find query, drop target, dialog prompt, file name, help topic, logs #n or URL filter',
  },
  mode: { type: 'string', description: 'Action variant; see help' },
  offset: { type: 'string', description: 'read: next offset from last read' },
  full: {
    type: 'boolean',
    description:
      'read: larger page; screenshot: whole page; logs: whole buffer',
  },
  background: {
    type: 'boolean',
    description: 'open: false to show the tab to the user',
  },
  files: { type: 'array', items: { type: 'string' }, description: 'upload' },
  timeoutMs: { type: 'integer', description: 'wait/navigation: max 10000' },
  retry: {
    type: 'boolean',
    description: 'screenshot: only if the user asked to retry',
  },
};

const REF = /^(?:f\d+:)?r\d+\.\d+$/;
const POINT = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/;
const MODES = {
  navigate: ['back', 'forward', 'reload'],
  click: ['left', 'right', 'middle', 'double'],
  type: ['fill', 'insert', 'select', 'check', 'uncheck'],
  wait: ['visible', 'hidden', 'text', 'url', 'ready', 'networkidle'],
  scroll: ['down', 'up', 'left', 'right', 'into'],
  dialog: ['inspect', 'accept', 'dismiss'],
  read: ['main', 'page', 'viewport'],
  logs: ['problems', 'requests', 'console'],
};

export function parseTarget(value) {
  if (value === undefined || value === '') return {};
  if (REF.test(value)) return { ref: value };
  const point = POINT.exec(value);
  if (point) return { x: Number(point[1]), y: Number(point[2]) };
  return { selector: value };
}

export function normalize(input) {
  const { action, mode, text, target, offset, full, retry, ...rest } = input;
  if (mode !== undefined && MODES[action] && !MODES[action].includes(mode))
    throw new Error(
      `${action} mode must be one of ${MODES[action].join('/')}.`,
    );
  if (mode !== undefined && !MODES[action])
    throw new Error(`${action} does not take a mode.`);
  const args = { action, ...rest, ...parseTarget(target) };
  const needTarget = () => {
    if (!target) throw new Error(`${action} requires target`);
  };
  switch (action) {
    case 'help':
      if (text) args.topic = text;
      break;
    case 'open':
      if (!args.url) throw new Error('open requires url');
      break;
    case 'navigate':
      if (mode) args.mode = mode;
      else if (!args.url) throw new Error('navigate requires url or mode');
      break;
    case 'read':
      if (mode === 'page') args.scope = 'page';
      if (mode === 'viewport') args.viewportOnly = true;
      if (full) args.detail = 'full';
      if (offset !== undefined) {
        const match = /^(\d+),(\d+)$/.exec(String(offset));
        if (!match) throw new Error('offset must be the next value from read');
        args.textOffset = Number(match[1]);
        args.elementOffset = Number(match[2]);
      }
      break;
    case 'find':
      if (!text) throw new Error('find requires text');
      args.query = text;
      break;
    case 'click':
      if (mode === 'right' || mode === 'middle') args.button = mode;
      if (mode === 'double') args.clickCount = 2;
      if (!target) throw new Error('click requires target');
      break;
    case 'hover':
      needTarget();
      break;
    case 'drag': {
      needTarget();
      if (!text) throw new Error('drag requires text: the drop target');
      const to = parseTarget(text);
      args.toRef = to.ref;
      args.toSelector = to.selector;
      args.toX = to.x;
      args.toY = to.y;
      break;
    }
    case 'type':
      needTarget();
      if (mode === 'check' || mode === 'uncheck') {
        args.mode = 'check';
        args.checked = mode === 'check';
      } else {
        args.mode = mode ?? 'fill';
        if (text === undefined)
          throw new Error(`type ${args.mode} requires text`);
        args.text = text;
      }
      break;
    case 'press': {
      if (!text)
        throw new Error('press requires text, e.g. Enter or Control+a');
      const parts = text.split('+');
      args.key = parts.pop() || '+'; // "Control++" presses +
      const modifiers = parts.filter(Boolean);
      if (modifiers.some((m) => !MODIFIERS[m]))
        throw new Error(
          'press modifiers must be Alt, Control, Meta or Shift, e.g. Control+a.',
        );
      if (modifiers.length) args.modifiers = modifiers;
      break;
    }
    case 'scroll':
      if (mode === 'into') {
        needTarget();
        args.intoView = true;
      } else {
        const step = 600;
        const [dx, dy] = {
          up: [0, -step],
          left: [-step, 0],
          right: [step, 0],
        }[mode] ?? [0, step];
        args.deltaX = dx;
        args.deltaY = dy;
      }
      break;
    case 'wait':
      args.condition = mode ?? (target ? 'visible' : 'ready');
      if (['text', 'url'].includes(args.condition) && !text)
        throw new Error(`wait ${args.condition} requires text`);
      if (text !== undefined) args.text = text;
      break;
    case 'dialog':
      args.mode = mode ?? 'inspect';
      if (text !== undefined) args.text = text;
      break;
    case 'screenshot':
      if (full) args.fullPage = true;
      if (retry) args.retryScreenshot = true;
      break;
    case 'evaluate':
      if (!text) throw new Error('evaluate requires text (JavaScript)');
      args.expression = text;
      break;
    case 'upload':
      needTarget();
      if (!args.files?.length) throw new Error('upload requires files');
      break;
    case 'download':
      if (!args.url && !target)
        throw new Error('download requires url or target');
      if (text) args.text = text;
      break;
    case 'logs': {
      args.mode = mode ?? 'problems';
      if (full) args.all = true;
      const number = /^#(\d+)$/.exec(text?.trim() ?? '');
      if (number) args.request = Number(number[1]);
      else if (text) args.filter = text;
      break;
    }
  }
  if (!TAB_FREE.includes(action) && !args.tabId)
    throw new Error(`${action} requires tabId from open or list`);
  return args;
}
