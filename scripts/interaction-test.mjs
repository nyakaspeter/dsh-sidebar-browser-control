import http from 'node:http';
import assert from 'node:assert/strict';
import { apply } from '../src/index.js';
import { SidebarController } from '../src/controller.js';
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/frame') {
    res.end('<button id="inside">Frame button</button>');
    return;
  }
  res.end(`<!doctype html><title>Browser controls fixture</title><style>#box{height:100px;overflow:auto}#drag{width:80px;height:30px;background:blue}#drop{width:80px;height:30px;background:red}body{height:2200px}</style>
 <label>Name<input id="name"></label><input type="checkbox" id="check"><select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select>
 <input id="auto" aria-label="Auto"><div id="editor" contenteditable="true">old text</div><button id="button">Click me</button><a id="link" href="/next">Next page</a><div id="drag">Drag</div><div id="drop">Drop</div><div id="box"><div style="height:1000px">Scrollable</div></div><div id="shadow"></div><iframe src="/frame"></iframe>
 <script>window.count=0;button.onclick=()=>window.count++;window.moves=0;drop.onmouseup=()=>window.moves++;window.keys=[];window.inputTypes=[];document.addEventListener('input',e=>window.inputTypes.push(e.target.id+':'+e.inputType));document.addEventListener('keydown',e=>window.keys.push(e.key));document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button id="shadowButton">Shadow button</button>';setTimeout(()=>{const p=document.createElement('p');p.textContent='Loaded later';document.body.append(p)},300);</script>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`,
  c = new SidebarController();
let session, tab;
const cleanups = [];
try {
  session = (await c.run({ action: 'status' }, 'test')).client.visibleSession;
  let tool;
  apply({
    effect: (fn) => cleanups.push(fn()),
    tools: { register: (t) => (tool = t) },
  });
  // Reads, finds and logs are plain text; other results are JSON.
  const run = async (args) => {
    const out = await tool.execute(
      { ...(tab ? { tabId: tab.tabId } : {}), ...args },
      { agent: { id: session }, signal: new AbortController().signal },
    );
    try {
      return JSON.parse(out);
    } catch {
      return out;
    }
  };
  const refOf = (text, label) =>
    new RegExp(`^(\\S+) \\S+ ${JSON.stringify(label)}`, 'm').exec(text)?.[1];
  tab = await run({ action: 'open', url: base });
  await run({ action: 'wait', mode: 'text', text: 'Loaded later' });
  const snap = await run({ action: 'read' }),
    ref = refOf(snap, 'Name');
  assert.ok(ref, snap);
  assert.ok(refOf(snap, 'Shadow button'));
  assert.ok(refOf(snap, 'Frame button'));
  const found = await run({ action: 'find', text: 'click me' });
  assert.match(found, /^Found 1 for "click me":\n\S+ button "Click me"/);
  await run({ action: 'type', target: ref, text: 'Alice' });
  await run({
    action: 'type',
    target: '#choice',
    mode: 'select',
    text: 'Beta',
  });
  await run({ action: 'type', target: '#check', mode: 'check' });
  await run({ action: 'press', target: '#name', text: 'ArrowRight' });
  await run({ action: 'press', target: '#name', text: 'End' });
  await run({ action: 'press', target: '#name', text: 'x' });
  await run({ action: 'press', target: '#name', text: '!' });
  await run({ action: 'press', target: '#name', text: 'Shift+1' });
  await run({
    action: 'type',
    target: '#auto',
    mode: 'insert',
    text: 'a@b.c',
  });
  await run({ action: 'type', target: '#editor', text: 'new text' });
  await run({ action: 'click', target: '#button', mode: 'double' });
  await run({ action: 'hover', target: '#button' });
  await run({ action: 'drag', target: '#drag', text: '#drop' });
  assert.ok((await run({ action: 'scroll', target: '#box' })).y > 0);
  const state = await run({
    action: 'evaluate',
    text: '({name:document.querySelector("#name").value,checked:document.querySelector("#check").checked,choice:document.querySelector("#choice").value,count:window.count,keys:window.keys,moves:window.moves,auto:document.querySelector("#auto").value,editor:document.querySelector("#editor").textContent,inputTypes:window.inputTypes})',
  });
  console.log('Input verification:', JSON.stringify(state));
  assert.equal(state.name, 'Alicex!!');
  assert.equal(state.auto, 'a@b.c');
  assert.equal(state.editor, 'new text');
  assert.ok(state.inputTypes.includes('auto:insertText'), state.inputTypes);
  assert.ok(state.inputTypes.includes('editor:insertText'), state.inputTypes);
  assert.equal(state.checked, true);
  assert.equal(state.choice, 'b');
  assert.equal(state.count, 2);
  assert.ok(state.keys.includes('x'));
  assert.ok(state.keys.includes('ArrowRight'));
  assert.equal(state.moves, 1);
  await run({ action: 'read' });
  await assert.rejects(run({ action: 'click', target: ref }), /Stale/);
  await run({ action: 'focus' });
  await run({ action: 'hide' });
  assert.equal(await run({ action: 'evaluate', text: 'window.count' }), 2);
  const clicked = await run({ action: 'click', target: '#link' });
  assert.equal(
    clicked.navigation?.url,
    base + '/next',
    JSON.stringify(clicked),
  );
  assert.equal(clicked.navigation.loaded, true);
  await run({ action: 'navigate', mode: 'back' });
  await run({ action: 'wait', mode: 'ready' });
  const plain = await run({ action: 'click', target: '#button' });
  assert.equal(plain.navigation, undefined, JSON.stringify(plain));
  const navigated = await run({ action: 'navigate', url: base + '/next' });
  assert.equal(navigated.navigation?.loaded, true, JSON.stringify(navigated));
  await run({ action: 'navigate', mode: 'back' });
  await run({ action: 'wait', mode: 'ready' });
  await run({ action: 'navigate', mode: 'forward' });
  await run({ action: 'navigate', mode: 'reload' });
  assert.equal(
    (
      await run({
        action: 'wait',
        mode: 'text',
        text: 'never present',
        timeoutMs: 50,
      })
    ).code,
    'WAIT_TIMEOUT',
  );
  await run({ action: 'focus' });
  for (const kind of ['alert', 'confirm', 'prompt']) {
    await run({
      action: 'evaluate',
      text: `setTimeout(()=>{try{window.dialogResult=${kind}('Fixture ${kind}')}catch(e){window.dialogError=e.message}},10);true`,
    });
    await new Promise((r) => setTimeout(r, 100));
    const pending = await run({ action: 'dialog', mode: 'inspect' });
    if (kind === 'prompt' && pending.lastDialog?.type !== 'prompt') {
      const error = await run({
        action: 'evaluate',
        text: 'window.dialogError',
      });
      assert.match(error, /not supported/i);
      console.log('DSH does not support native prompt dialogs.');
      continue;
    }
    if (!pending.dialog) {
      assert.equal(pending.lastDialog?.type, kind);
      assert.equal(pending.lastDialog.status, 'closed');
      console.log(
        `DSH automatically closed ${kind}; tool reports closed state.`,
      );
      continue;
    }
    const blocked = await run({ action: 'read' });
    assert.equal(blocked.code, 'DIALOG_OPEN');
    await run({
      action: 'dialog',
      mode: kind === 'confirm' ? 'dismiss' : 'accept',
      ...(kind === 'prompt' ? { text: 'answer' } : {}),
    });
    const value = await run({
      action: 'evaluate',
      text: 'window.dialogResult??null',
    });
    if (kind === 'confirm') assert.equal(value, false);
    if (kind === 'prompt') assert.equal(value, 'answer');
  }
  console.log(
    'PASS: JavaScript dialog reporting; host auto-dismiss and unsupported prompt limits detected without hangs.',
  );
  console.log(
    'PASS: real DSH background DOM refs, shadow/frame reads, forms, text insertion, keyboard, mouse, drag, targeted scrolling, hide/reveal, history, navigation after click and bounded wait.',
  );
} finally {
  if (tab)
    await c.run({ action: 'close', tabId: tab.tabId }, session).catch(() => {});
  c.dispose();
  for (const cleanup of cleanups) cleanup?.();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
