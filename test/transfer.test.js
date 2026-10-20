import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDownload,
  downloadsDirectory,
  fileName,
  resolveUploads,
  downloadThroughPage,
  sanitizeName,
  sweepAllPartials,
} from '../src/transfer.js';

const save = async (dir, name, data) => {
  const file = await createDownload(dir, name);
  await file.write(data);
  await file.finish();
  return file.path;
};

test('download names come from headers or URLs and are filesystem-safe', () => {
  assert.equal(
    fileName({ disposition: 'attachment; filename="report.pdf"' }),
    'report.pdf',
  );
  assert.equal(
    fileName({
      disposition: "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.txt",
    }),
    'résumé.txt',
  );
  assert.equal(
    fileName({ url: 'https://x.example/a/b/data.csv?q=1' }),
    'data.csv',
  );
  assert.equal(fileName({ url: 'https://x.example/' }), 'download');
  assert.equal(
    fileName({ suggested: 'invoice.pdf', url: 'https://x.example/get?id=1' }),
    'invoice.pdf',
  );
  assert.equal(
    fileName({
      disposition: 'attachment; filename="server.pdf"',
      suggested: 'link.pdf',
    }),
    'server.pdf',
  );
  assert.equal(sanitizeName('../../etc/passwd'), '__.._etc_passwd');
  assert.equal(sanitizeName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeName('a\u0000b'), 'a_b');
  assert.equal(sanitizeName('x'.repeat(300)).length, 120);
});
test('downloads never overwrite existing files and stay per chat', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-dl-'));
  const dir = downloadsDirectory('chat-a', base);
  assert.notEqual(dir, downloadsDirectory('chat-b', base));
  const first = await save(dir, 'a.txt', Buffer.from('1'));
  const second = await save(dir, 'a.txt', Buffer.from('2'));
  assert.notEqual(first, second);
  assert.match(second, /a \(1\)\.txt$/);
  assert.equal(await readFile(first, 'utf8'), '1');
});
test('uploads are confined to the working directory and downloads folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-up-'));
  const cwd = join(root, 'project'),
    downloads = join(root, 'downloads'),
    outside = join(root, 'secret');
  for (const dir of [cwd, downloads, outside]) await mkdir(dir);
  await writeFile(join(cwd, 'a.txt'), 'a');
  await writeFile(join(downloads, 'b.txt'), 'b');
  await writeFile(join(outside, 'key'), 'k');
  // Creating symlinks needs extra privileges on Windows; skip that case there.
  const linked = await symlink(join(outside, 'key'), join(cwd, 'link')).then(
    () => true,
    () => false,
  );
  const files = await resolveUploads(['a.txt', join(downloads, 'b.txt')], {
    cwd,
    roots: [downloads],
  });
  assert.equal(files.length, 2);
  for (const bad of [
    join(outside, 'key'),
    ...(linked ? ['link'] : []),
    '../secret/key',
  ])
    await assert.rejects(
      resolveUploads([bad], { cwd, roots: [downloads] }),
      /limited to files/,
      bad,
    );
  await assert.rejects(
    resolveUploads(['missing.txt'], { cwd, roots: [] }),
    /not found/,
  );
  await assert.rejects(
    resolveUploads([cwd], { cwd: root, roots: [] }),
    /regular/,
  );
  await assert.rejects(
    resolveUploads(['a.txt'], { roots: [downloads] }),
    /absolute path/,
  );
  await assert.rejects(resolveUploads([], { cwd, roots: [] }), /1–20/);
});
test('page downloads read the response stream in bounded chunks', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-stream-'));
  const parts = [new Uint8Array(3 * 1024 * 1024).fill(65), Buffer.from('end')];
  let pulled = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            const next = parts[pulled++];
            next ? controller.enqueue(next) : controller.close();
          },
        }),
        { headers: { 'content-type': 'application/octet-stream' } },
      ),
  );
  const evaluations = [];
  // The serialized page functions run here exactly as in the page.
  const evaluate = async (expression) => {
    evaluations.push(expression);
    return (0, eval)(expression);
  };
  const result = await downloadThroughPage({
    evaluate,
    source: 'https://site.test/a.bin',
    directory: dir,
    name: () => 'a.bin',
  });
  assert.equal(result.bytes, 3 * 1024 * 1024 + 3);
  assert.equal(result.mediaType, 'application/octet-stream');
  const data = await readFile(result.path);
  assert.equal(data.subarray(-3).toString(), 'end');
  assert.equal(data[0], 65);
  await new Promise((r) => setImmediate(r));
  assert.equal(
    Object.keys(globalThis).filter((k) => k.startsWith('__dshDownload_'))
      .length,
    0,
    'the stream reference is released',
  );
});
test('downloads are hidden partial files until complete; stale ones are swept', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-part-'));
  const dir = downloadsDirectory('chat', base);
  const file = await createDownload(dir, 'big.bin');
  await file.write(Buffer.from('half'));
  const [partial] = await readdir(dir);
  assert.match(partial, /^\.download-.+\.part$/);
  assert.equal(file.path, null, 'no real name before it completes');
  await file.finish();
  assert.deepEqual(await readdir(dir), ['big.bin']);
  assert.equal(await readFile(file.path, 'utf8'), 'half');
  // A download cut off by a quit leaves a partial; an active one keeps writing.
  const cut = join(dir, '.download-0000-dead.part');
  const active = join(dir, '.download-1111-live.part');
  await writeFile(cut, 'x');
  await writeFile(active, 'y');
  const old = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(cut, old, old);
  await sweepAllPartials(base);
  assert.deepEqual((await readdir(dir)).sort(), [
    '.download-1111-live.part',
    'big.bin',
  ]);
});
