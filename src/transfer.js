import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { website } from './cdp.js';
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

export function isPrivateAddress(address) {
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPrivateAddress(mapped[1]);
    return (
      a === '::' ||
      a === '::1' ||
      /^f[cd]/.test(a) ||
      /^fe[89ab]/.test(a) ||
      a.startsWith('ff')
    );
  }
  const [a, b] = address.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

// The host-side fallback must not become a way to read local or intranet
// services that the page itself could not read because of CORS.
export async function assertPublicUrl(value, resolver = lookup) {
  const url = new URL(website(value));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await resolver(host, { all: true })).map((r) => r.address);
  if (!addresses.length || addresses.some(isPrivateAddress))
    throw new Error(
      'Host-side download refused for a private or local network address.',
    );
  return url.href;
}

const tooLarge = (n) =>
  `Download exceeds the ${MAX_DOWNLOAD_BYTES / 1048576} MB limit (${n} bytes).`;

// Cookies are looked up per hop so a redirect never receives another site's
// cookies. The body streams into the file returned by open(info).
export async function hostFetch(
  url,
  {
    cookiesFor,
    userAgent,
    referer,
    signal,
    request = fetch,
    resolver,
    limit = MAX_DOWNLOAD_BYTES,
    open: openFile,
  },
) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    current = await assertPublicUrl(current, resolver);
    const cookie = await cookiesFor(current);
    const response = await request(current, {
      redirect: 'manual',
      signal,
      headers: {
        ...(cookie && { cookie }),
        ...(userAgent && { 'user-agent': userAgent }),
        ...(referer && { referer }),
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect without a location.');
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok)
      throw new Error(`Download failed: HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    if (declared > limit) throw new Error(tooLarge(declared));
    const info = {
      mediaType: response.headers.get('content-type') ?? undefined,
      disposition: response.headers.get('content-disposition') ?? undefined,
      url: current,
    };
    // The file name can depend on response headers, so the sink opens late.
    const file = await openFile(info);
    try {
      for await (const chunk of response.body ?? []) await file.write(chunk);
      await file.finish();
    } catch (error) {
      await file.abort();
      throw error;
    }
    return { ...info, path: file.path, bytes: file.bytes };
  }
  throw new Error('Too many redirects.');
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
