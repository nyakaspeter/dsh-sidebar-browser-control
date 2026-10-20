import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDownload,
  downloadsDirectory,
  fileName,
  resolveUploads,
  sanitizeName,
  saveDownload,
} from '../src/transfer.js';

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
  assert.equal(sanitizeName('../../etc/passwd'), '__.._etc_passwd');
  assert.equal(sanitizeName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeName('a\u0000b'), 'a_b');
  assert.equal(sanitizeName('x'.repeat(300)).length, 120);
});
test('downloads never overwrite existing files and stay per chat', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-dl-'));
  const dir = downloadsDirectory('chat-a', base);
  assert.notEqual(dir, downloadsDirectory('chat-b', base));
  const first = await saveDownload(dir, 'a.txt', Buffer.from('1'));
  const second = await saveDownload(dir, 'a.txt', Buffer.from('2'));
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
