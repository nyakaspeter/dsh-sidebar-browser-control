import WebSocket from 'ws';

export function endpoint(value = 'http://127.0.0.1:19222') {
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
export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.sequence = 0;
    this.pending = new Map();
    this.events = [];
    this.recording = false;
    this.eventBytes = 0;
    this.droppedEvents = 0;
    this.dialog = null;
    this.lastDialog = null;
    ws.on('message', (data) => {
      const message = JSON.parse(data);
      if (message.id) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        entry.cleanup();
        message.error
          ? entry.reject(new Error(message.error.message))
          : entry.resolve(message.result);
      } else {
        if (message.method === 'Page.javascriptDialogOpening') {
          this.dialog = message.params;
          this.lastDialog = { ...message.params, status: 'open' };
          const error = Object.assign(
            new Error('A browser dialog requires handling.'),
            { dialog: this.dialog },
          );
          this.fail(error);
        }
        if (message.method === 'Page.javascriptDialogClosed') {
          this.lastDialog = {
            ...this.lastDialog,
            ...message.params,
            status: 'closed',
          };
          this.dialog = null;
        }
        if (this.recording) this.recordEvent(message);
      }
    });
    ws.on('close', () => this.fail(new Error('CDP connection closed')));
    ws.on('error', (error) => this.fail(error));
  }
  recordEvent(message) {
    let text = JSON.stringify(message);
    if (text.length > 2000) {
      message = {
        method: message.method,
        truncated: true,
        preview: text.slice(0, 1800),
      };
      text = JSON.stringify(message);
    }
    const bytes = Buffer.byteLength(text);
    this.events.push(message);
    this.eventBytes += bytes;
    while (this.events.length > 100 || this.eventBytes > 64000) {
      this.eventBytes -= Buffer.byteLength(JSON.stringify(this.events.shift()));
      this.droppedEvents++;
    }
  }
  drainEvents() {
    const events = [];
    let bytes = 0;
    while (this.events.length && events.length < 20) {
      const size = Buffer.byteLength(JSON.stringify(this.events[0]));
      if (events.length && bytes + size > 16000) break;
      events.push(this.events.shift());
      bytes += size;
      this.eventBytes -= size;
    }
    const dropped = this.droppedEvents;
    this.droppedEvents = 0;
    return {
      events,
      remaining: this.events.length,
      ...(dropped ? { dropped } : {}),
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
  call(method, params = {}, signal) {
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
      this.ws.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          this.pending.delete(id);
          cleanup();
          reject(error);
        }
      });
    });
  }
  async evaluate(expression, signal) {
    const result = await this.call(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      signal,
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
