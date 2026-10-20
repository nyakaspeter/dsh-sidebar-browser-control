// Plain-text renderings of large results: cheaper on context than JSON (no
// repeated keys, escaped newlines or empty fields).
const quote = (value) => JSON.stringify(value);

export function formatControl(item) {
  const parts = [item.ref, item.kind];
  if (item.label) parts.push(quote(item.label));
  if (item.inputType) parts.push(`(${item.inputType})`);
  if (item.value !== undefined) parts.push(`=${quote(item.value)}`);
  if (item.checked !== undefined) parts.push(item.checked ? '[x]' : '[ ]');
  if (item.disabled) parts.push('[disabled]');
  if (item.options) parts.push(`{${item.options.join('|')}}`);
  if (item.href) parts.push(`→ ${item.href}`);
  return parts.join(' ');
}

export function formatRead(result) {
  const lines = [`# ${result.title || '(untitled)'}`];
  const notes = [result.url];
  if (result.readyState && result.readyState !== 'complete')
    notes.push('still loading');
  if (result.scope === 'main')
    notes.push('text: main content only (mode "page" for all)');
  lines.push(notes.join(' · '), '');
  if (result.text) lines.push(result.text.trim(), '');
  const shown = result.elements.length;
  lines.push(
    shown
      ? `Controls (${shown}${result.totalElements > shown ? ` of ${result.totalElements}` : ''}):`
      : 'No visible controls.',
  );
  for (const item of result.elements) lines.push(formatControl(item));
  if (result.next) lines.push('', `More: offset "${result.next}"`);
  if (result.frames?.length)
    lines.push(`Frames read: ${result.frames.map((f) => f.url).join(', ')}`);
  if (result.inaccessibleFrames?.length)
    lines.push(`Unreadable frames: ${result.inaccessibleFrames.length}`);
  if (result.blocking) lines.push(`Blocking: ${quote(result.blocking)}`);
  return lines.join('\n');
}

export function formatFind(result, query) {
  if (!result.found.length)
    return `No match for ${quote(query)}. Try read, or another wording.`;
  return [
    `Found ${result.found.length} for ${quote(query)}:`,
    ...result.found.map(formatControl),
  ].join('\n');
}

const short = (url, max = 150) =>
  url.length > max ? `${url.slice(0, max - 1)}…` : url;
const size = (n) =>
  n === undefined ? '' : n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}kB`;
export function formatRequest(r) {
  const status = r.error ? `ERR ${r.error}` : (r.status ?? '...');
  const extra = [r.ms !== undefined && `${r.ms}ms`, size(r.size)]
    .filter(Boolean)
    .join(' ');
  return `#${r.n} ${r.method} ${status} ${r.type ?? ''} ${extra} ${short(r.url)}`.replace(
    /\s+/g,
    ' ',
  );
}
export function formatLogs(result) {
  if (result.body !== undefined) {
    const r = result.request;
    return [
      formatRequest(r),
      ...(r.mime ? [`content-type: ${r.mime}`] : []),
      ...(r.postData ? ['request body:', r.postData] : []),
      'response body:',
      result.body,
    ].join('\n');
  }
  const lines = [];
  if (result.console) {
    lines.push(
      result.console.length
        ? `Console (${result.mode === 'console' ? 'all' : 'errors and warnings'}):`
        : 'Console: nothing recorded.',
    );
    for (const c of result.console) lines.push(`[${c.level}] ${c.text}`);
  }
  if (result.requests) {
    if (lines.length) lines.push('');
    lines.push(
      result.requests.length
        ? `${result.mode === 'requests' ? 'Requests (latest last)' : 'Failed requests'}:`
        : result.mode === 'requests'
          ? 'Requests: nothing recorded.'
          : 'Failed requests: none.',
    );
    for (const r of result.requests) lines.push(formatRequest(r));
  }
  lines.push('', result.note);
  return lines.join('\n');
}
