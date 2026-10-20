import WebSocket from 'ws';

export function endpoint(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('CDP endpoint must be http://127.0.0.1:PORT');
  return url.origin;
}
export function website(value) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('Only HTTP(S) URLs without credentials are supported');
  return url.href;
}
export async function targets(base) {
  const response = await fetch(`${endpoint(base)}/json/list`, {
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`CDP discovery failed: ${response.status}`);
  return response.json();
}
// One flattened CDP connection. Child sessions (cross-origin iframes) share the
// socket and are addressed by sessionId; events carry the session they came from.
export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Map();
    // Flattened child sessions (out-of-process iframes) known to this socket,
    // so modules that start listening late still see earlier attachments.
    this.children = new Map();
    this.dialog = null;
    this.lastDialog = null;
    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return; // Never let a malformed frame throw inside the host process.
      }
      if (message.id) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        entry.cleanup();
        message.error
          ? entry.reject(new Error(message.error.message))
          : entry.resolve(message.result);
        return;
      }
      if (message.method === 'Target.attachedToTarget')
        this.children.set(message.params.sessionId, message.params.targetInfo);
      if (message.method === 'Target.detachedFromTarget')
        this.children.delete(message.params.sessionId);
      if (message.method === 'Page.javascriptDialogOpening') {
        this.dialog = { ...message.params };
        if (message.sessionId)
          Object.defineProperty(this.dialog, 'sessionId', {
            value: message.sessionId,
          });
        this.lastDialog = { ...message.params, status: 'open' };
        this.fail(
          Object.assign(new Error('A browser dialog requires handling.'), {
            dialog: this.dialog,
          }),
        );
      }
      if (message.method === 'Page.javascriptDialogClosed') {
        this.lastDialog = {
          ...this.lastDialog,
          ...message.params,
          status: 'closed',
        };
        this.dialog = null;
      }
      for (const listener of [...(this.listeners.get(message.method) ?? [])])
        try {
          listener(message.params, message.sessionId);
        } catch (error) {
          console.error(error);
        }
    });
    ws.on('close', () => this.fail(new Error('CDP connection closed')));
    ws.on('error', (error) => this.fail(error));
  }
  on(method, listener) {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size && this.listeners.get(method) === set)
        this.listeners.delete(method);
    };
  }
  fail(error) {
    for (const entry of this.pending.values()) {
      entry.cleanup();
      entry.reject(error);
    }
    this.pending.clear();
  }
  static async connect(url, base) {
    const u = new URL(url),
      b = new URL(endpoint(base));
    if (u.protocol !== 'ws:' || u.hostname !== b.hostname || u.port !== b.port)
      throw new Error('Unexpected debugger socket origin');
    const ws = new WebSocket(url, {
      handshakeTimeout: 5000,
      maxPayload: 32 * 1024 * 1024,
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new CDP(ws);
  }
  call(method, params = {}, signal, sessionId) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const abort = () => {
        this.pending.delete(id);
        cleanup();
        reject(signal?.reason ?? new Error('CDP request timed out'));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      this.ws.send(
        JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }),
        (error) => {
          if (error) {
            this.pending.delete(id);
            cleanup();
            reject(error);
          }
        },
      );
    });
  }
  async evaluate(expression, signal, { contextId, sessionId } = {}) {
    const result = await this.call(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        ...(contextId && { contextId }),
      },
      signal,
      sessionId,
    );
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    return result.result.value;
  }
  close() {
    this.fail(new Error('CDP disposed'));
    this.ws.close();
  }
}
