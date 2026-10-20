import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { stateDirectory } from './desktop.js';

// The page reads the response stream chunk by chunk and each chunk goes
// straight to disk, so memory stays at about one chunk on both sides and
// downloads have no size limit.
const CHUNK = 4 * 1024 * 1024;
// In-progress downloads are hidden ".part" files (real names never start with
// a dot). One untouched this long was cut off by a quit or crash.
const PARTIAL = /^\.download-[0-9a-f-]+\.part$/,
  STALE_PARTIAL_MS = 10 * 60 * 1000;
const MAX_UPLOAD_FILES = 20;

// Downloads stay in a plugin-owned folder per chat; agents move them with their
// own file tools, which remain subject to DSH's filesystem policy.
export function downloadsDirectory(session, base = stateDirectory()) {
  const id = createHash('sha256').update(String(session)).digest('hex');
  return join(base, 'downloads', id.slice(0, 16));
}

export function sanitizeName(name) {
  const clean = String(name ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
    .replace(/^[.\s]+/, '_')
    .replace(/[.\s]+$/, '')
    .slice(0, 120);
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(clean)
    ? `_${clean}`
    : clean || 'download';
}

// Content-Disposition first, then the link's download attribute, then the URL.
export function fileName({ disposition, suggested, url } = {}) {
  const header = String(disposition ?? '');
  const encoded = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  let name;
  try {
    name = encoded
      ? decodeURIComponent(encoded[1].trim())
      : plain
        ? (plain[2] ?? plain[1]).trim()
        : suggested ||
          decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  } catch {
    name = '';
  }
  return sanitizeName(name);
}

// Writes to a hidden partial file and gives it its real, unique name only once
// complete, so a failed, cancelled or interrupted download never looks finished.
export async function createDownload(directory, name) {
  await mkdir(directory, { recursive: true });
  void sweepPartials(directory);
  const partial = join(directory, `.download-${randomUUID()}.part`);
  const handle = await open(partial, 'wx');
  let bytes = 0,
    closed = false,
    path = null;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  return {
    get path() {
      return path;
    },
    get bytes() {
      return bytes;
    },
    async write(chunk) {
      await handle.write(chunk);
      bytes += chunk.length;
    },
    async finish() {
      await close();
      path = await publish(partial, directory, name);
    },
    async abort() {
      await close().catch(() => {});
      await rm(partial, { force: true });
    },
  };
}
// Moves the partial file to the first free name; never overwrites a file.
async function publish(partial, directory, name) {
  const ext = extname(name),
    stem = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const path = join(directory, i ? `${stem} (${i})${ext}` : name);
    try {
      // A hard link fails if the name exists, unlike rename.
      await link(partial, path);
      await unlink(partial);
      return path;
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      if (!['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes(error.code))
        throw error;
      // No hard links on this filesystem: check, then rename.
      if (
        await stat(path).then(
          () => true,
          () => false,
        )
      )
        continue;
      await rename(partial, path);
      return path;
    }
  }
  await rm(partial, { force: true });
  throw new Error('Too many downloads share this file name.');
}
// Removes partial files left by downloads that were cut off. Active
// downloads keep writing, so their files are never stale.
async function sweepPartials(directory, now = Date.now()) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  for (const name of names.filter((n) => PARTIAL.test(n))) {
    const file = join(directory, name);
    try {
      if (now - (await stat(file)).mtimeMs > STALE_PARTIAL_MS)
        await rm(file, { force: true });
    } catch {}
  }
}
// Sweeps every chat's downloads folder (on startup).
export async function sweepAllPartials(base = stateDirectory()) {
  const root = join(base, 'downloads');
  let folders = [];
  try {
    folders = await readdir(root);
  } catch {
    return;
  }
  await Promise.all(folders.map((f) => sweepPartials(join(root, f))));
}

export async function resolveUploads(files, { cwd, roots }) {
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.length > MAX_UPLOAD_FILES ||
    files.some((f) => typeof f !== 'string' || !f)
  )
    throw new Error(`files must list 1–${MAX_UPLOAD_FILES} file paths.`);
  const allowed = (
    await Promise.all(
      [cwd, ...roots].filter(Boolean).map((r) => realpath(r).catch(() => null)),
    )
  ).filter(Boolean);
  const resolved = [];
  for (const file of files) {
    if (!isAbsolute(file) && !cwd)
      throw new Error(`Use an absolute path for ${file}.`);
    let real;
    try {
      real = await realpath(isAbsolute(file) ? file : resolve(cwd, file));
    } catch {
      throw new Error(`File not found: ${file}`);
    }
    if (!(await stat(real)).isFile())
      throw new Error(`Not a regular file: ${file}`);
    const inside = allowed.some((root) => {
      const rel = relative(root, real);
      return rel && !rel.startsWith('..') && !isAbsolute(rel);
    });
    if (!inside)
      throw new Error(
        `Uploads are limited to files in this chat's working directory or its browser downloads folder; ${file} is outside them. Copy it there first if the user wants it uploaded.`,
      );
    resolved.push(real);
  }
  return resolved;
}

// Downloads through the page's own fetch (its cookies and origin). evaluate
// runs an expression in the frame's isolated world; name picks the file name
// from the response metadata.
export async function downloadThroughPage({
  evaluate,
  source,
  directory,
  name,
  signal,
}) {
  const J = JSON.stringify;
  const key = `__dshDownload_${randomUUID().replaceAll('-', '')}`;
  const cleanup = () =>
    evaluate(
      `globalThis[${J(key)}]?.reader?.cancel().catch(()=>{});delete globalThis[${J(key)}]`,
      AbortSignal.timeout(1000),
    ).catch(() => {});
  let meta;
  try {
    meta = await evaluate(`(${inPageFetch})(${J(source)},${J(key)})`, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (error.dialog) throw error;
    meta = { error: error.message };
  }
  if (meta.status) throw new Error(`Download failed: HTTP ${meta.status}`);
  if (meta.error)
    throw new Error(
      `Download failed: ${meta.error}. The page can only fetch files its site allows; open the file URL in a tab and download it from there.`,
    );
  const file = await createDownload(directory, name(meta));
  try {
    for (;;) {
      const chunk = await evaluate(
        `(${readChunk})(${J(key)},${CHUNK})`,
        signal,
      );
      if (chunk.data) await file.write(Buffer.from(chunk.data, 'base64'));
      if (chunk.done) break;
    }
    await file.finish();
  } catch (error) {
    await file.abort();
    throw error;
  } finally {
    void cleanup();
  }
  return {
    path: file.path,
    bytes: file.bytes,
    ...(meta.type && { mediaType: meta.type }),
    url: meta.url,
  };
}
// Serialized into the page's isolated world.
async function inPageFetch(url, key) {
  let response;
  try {
    response = await fetch(url, { credentials: 'include' });
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
  if (!response.ok) return { status: response.status };
  globalThis[key] = { reader: response.body?.getReader() };
  return {
    type: response.headers.get('content-type') || undefined,
    disposition: response.headers.get('content-disposition') || undefined,
    url: response.url,
  };
}
async function readChunk(key, size) {
  const state = globalThis[key];
  if (!state) throw Error('Download stream expired; download again.');
  const parts = [];
  let length = 0,
    done = !state.reader;
  while (!done && length < size) {
    const next = await state.reader.read();
    done = next.done;
    if (next.value) {
      parts.push(next.value);
      length += next.value.length;
    }
  }
  let text = '';
  for (const part of parts)
    for (let i = 0; i < part.length; i += 32768)
      text += String.fromCharCode.apply(null, part.subarray(i, i + 32768));
  return { data: btoa(text), done };
}
