import { createHash } from 'node:crypto';
import { mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { stateDirectory } from './desktop.js';

// Data is streamed to disk, so the cap bounds disk use and time, not memory.
export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 20;

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

export function fileName({ disposition, url, fallback = 'download' } = {}) {
  const header = String(disposition ?? '');
  const encoded = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  let name;
  try {
    name = encoded
      ? decodeURIComponent(encoded[1].trim())
      : plain
        ? (plain[2] ?? plain[1]).trim()
        : decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  } catch {
    name = '';
  }
  return sanitizeName(name || fallback);
}

// Opens a new, uniquely named file and appends chunks as they arrive. A failed
// or oversized download deletes its partial file.
export async function createDownload(
  directory,
  name,
  limit = MAX_DOWNLOAD_BYTES,
) {
  await mkdir(directory, { recursive: true });
  const ext = extname(name),
    stem = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const path = join(directory, i ? `${stem} (${i})${ext}` : name);
    let handle;
    try {
      handle = await open(path, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    let bytes = 0,
      closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await handle.close();
    };
    return {
      path,
      get bytes() {
        return bytes;
      },
      async write(chunk) {
        bytes += chunk.length;
        if (bytes > limit) throw new Error(tooLarge(bytes));
        await handle.write(chunk);
      },
      finish: close,
      async abort() {
        await close().catch(() => {});
        await rm(path, { force: true });
      },
    };
  }
  throw new Error('Too many downloads share this file name.');
}

export async function saveDownload(directory, name, data) {
  const file = await createDownload(directory, name, Infinity);
  try {
    await file.write(data);
    await file.finish();
  } catch (error) {
    await file.abort();
    throw error;
  }
  return file.path;
}

const tooLarge = (n) =>
  `Download exceeds the ${MAX_DOWNLOAD_BYTES / 1048576} MB limit (${n} bytes).`;

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
