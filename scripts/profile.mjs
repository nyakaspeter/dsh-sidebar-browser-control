// App-wide samples, not isolated plugin allocations. No process arguments or page content are printed.
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import { SidebarController } from '../src/controller.js';
function sample() {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,time=,comm='], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!m) return;
      const parts = m[4].split(':').map(Number);
      return {
        pid: +m[1],
        parent: +m[2],
        rss: +m[3],
        cpu: parts.reduce((v, n) => v * 60 + n, 0),
        name: m[5],
      };
    })
    .filter(Boolean);
  const candidates = rows.filter((r) =>
    /\/Contents\/MacOS\/DeepSeek Harness$/.test(r.name),
  );
  const main = candidates.find(
    (r) => !candidates.some((parent) => parent.pid === r.parent),
  );
  if (!main) throw Error('DSH not running');
  const ids = new Set([main.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of rows)
      if (ids.has(r.parent) && !ids.has(r.pid)) {
        ids.add(r.pid);
        changed = true;
      }
  }
  return rows.filter((r) => ids.has(r.pid));
}
async function measure(label) {
  const before = sample(),
    start = performance.now();
  await delay(5000);
  const after = sample(),
    elapsed = (performance.now() - start) / 1000;
  const cpu = after.reduce(
    (v, r) =>
      v +
      Math.max(0, r.cpu - (before.find((b) => b.pid === r.pid)?.cpu ?? r.cpu)),
    0,
  );
  console.log(
    JSON.stringify({
      label,
      processes: after.length,
      rssMiB: Math.round(after.reduce((v, r) => v + r.rss, 0) / 1024),
      cpuPercentOneCore: +((100 * cpu) / elapsed).toFixed(1),
      seconds: +elapsed.toFixed(1),
    }),
  );
}
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<title>Profile fixture</title><p>' +
      'Sample page content. '.repeat(2500) +
      '</p>' +
      Array.from(
        { length: 100 },
        (_, i) => `<button>Control ${i}</button>`,
      ).join(''),
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const c = new SidebarController(),
  tabs = [];
let session;
try {
  session = (await c.run({ action: 'status' }, 'profile')).client
    .visibleSession;
  if (!session) throw Error('Select a loaded chat first');
  await measure('idle');
  for (let i = 0; i < 3; i++) {
    const t = await c.run(
      { action: 'open', url: `http://127.0.0.1:${server.address().port}/` },
      session,
    );
    if (!t.tabId) throw Error(JSON.stringify(t));
    tabs.push(t.tabId);
    await c.run(
      {
        action: 'wait',
        tabId: t.tabId,
        condition: 'text',
        text: 'Sample page',
      },
      session,
    );
  }
  const read = await c.run({ action: 'read', tabId: tabs[0] }, session);
  console.log(
    JSON.stringify({
      readBytes: Buffer.byteLength(JSON.stringify(read)),
      controls: read.elements.length,
      textChars: read.text.length,
    }),
  );
  await measure('three local background tabs');
} finally {
  for (const tabId of tabs) await c.run({ action: 'close', tabId }, session);
  c.dispose();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
