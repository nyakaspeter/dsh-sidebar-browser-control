// Bounded per-tab record of requests and console output, captured from the
// moment the plugin attaches. Request headers are never kept (cookies, auth).
const MAX_REQUESTS = 100,
  MAX_CONSOLE = 50,
  MAX_BODY = 20000,
  MAX_POST = 2000;
const TEXTUAL =
  /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded)|[^;]*\+(json|xml))/i;

export class PageLogs {
  constructor(cdp) {
    this.cdp = cdp;
    this.requests = []; // oldest first
    this.byId = new Map(); // `${session}|${requestId}` -> entry
    this.console = [];
    this.seq = 0;
    this.consoleSeq = 0;
    this.seen = { problems: [0, 0], requests: [0, 0], console: [0, 0] };
    this.since = Date.now();
    this.disposers = [];
  }
  key(sessionId, requestId) {
    return `${sessionId ?? ''}|${requestId}`;
  }
  listen() {
    const on = (method, fn) => this.disposers.push(this.cdp.on(method, fn));
    on('Network.requestWillBeSent', (e, sid) => {
      if (!e.request) return;
      const previous = this.byId.get(this.key(sid, e.requestId));
      if (previous && e.redirectResponse) {
        previous.status = e.redirectResponse.status;
        previous.done = true;
      }
      const entry = {
        n: ++this.seq,
        id: e.requestId,
        sid,
        method: e.request.method,
        url: e.request.url,
        type: e.type?.toLowerCase(),
        start: e.timestamp,
        ...(e.request.postData && {
          postData: e.request.postData.slice(0, MAX_POST),
        }),
        hasPostData: e.request.hasPostData,
      };
      this.byId.set(this.key(sid, e.requestId), entry);
      this.requests.push(entry);
      while (this.requests.length > MAX_REQUESTS) {
        const old = this.requests.shift();
        if (this.byId.get(this.key(old.sid, old.id)) === old)
          this.byId.delete(this.key(old.sid, old.id));
      }
    });
    on('Network.responseReceived', (e, sid) => {
      const entry = this.byId.get(this.key(sid, e.requestId));
      if (!entry) return;
      entry.status = e.response.status;
      entry.mime = e.response.mimeType;
    });
    on('Network.loadingFinished', (e, sid) => {
      const entry = this.byId.get(this.key(sid, e.requestId));
      if (!entry) return;
      entry.done = true;
      entry.size = e.encodedDataLength;
      entry.ms = Math.round((e.timestamp - entry.start) * 1000);
    });
    on('Network.loadingFailed', (e, sid) => {
      const entry = this.byId.get(this.key(sid, e.requestId));
      if (!entry) return;
      entry.done = true;
      entry.canceled = e.canceled;
      entry.error = e.blockedReason
        ? `blocked:${e.blockedReason}`
        : e.errorText;
    });
    on('Runtime.consoleAPICalled', (e) =>
      this.log(
        { warning: 'warning', error: 'error', assert: 'error' }[e.type] ??
          e.type,
        e.args
          .map((a) =>
            a.value !== undefined
              ? typeof a.value === 'string'
                ? a.value
                : JSON.stringify(a.value)
              : (a.description ?? a.type),
          )
          .join(' '),
        e.stackTrace?.callFrames?.[0],
      ),
    );
    on('Runtime.exceptionThrown', ({ exceptionDetails: d }) =>
      this.log(
        'error',
        d.exception?.description ?? d.text,
        d.stackTrace?.callFrames?.[0] ?? {
          url: d.url,
          lineNumber: d.lineNumber,
        },
      ),
    );
    on('Log.entryAdded', ({ entry }) =>
      this.log(entry.level === 'verbose' ? 'debug' : entry.level, entry.text, {
        url: entry.url,
        lineNumber: entry.lineNumber,
      }),
    );
  }
  log(level, text, frame) {
    const where = frame?.url
      ? ` (${frame.url.split('/').pop() || frame.url}:${(frame.lineNumber ?? 0) + 1})`
      : '';
    this.console.push({
      n: ++this.consoleSeq,
      level,
      text: `${String(text ?? '').slice(0, 500)}${where}`,
    });
    if (this.console.length > MAX_CONSOLE) this.console.shift();
  }
  // Per-session domains; Network is enabled by the page context itself.
  async enable(sessionId, signal) {
    for (const domain of ['Runtime.enable', 'Log.enable'])
      await this.cdp.call(domain, {}, signal, sessionId).catch(() => {});
  }
  dispose() {
    this.disposers.splice(0).forEach((off) => off());
  }
  async query({ mode = 'problems', all = false, filter, request }, signal) {
    if (request !== undefined) return this.detail(request, signal);
    const [seenRequest, seenConsole] = this.seen[mode];
    const fresh = (list, seen) => (all ? list : list.filter((x) => x.n > seen));
    let requests = [],
      console = [];
    if (mode === 'problems' || mode === 'requests') {
      requests = fresh(this.requests, seenRequest).filter(
        (r) =>
          (mode === 'requests' ||
            (r.error && !r.canceled) ||
            r.status >= 400) &&
          (!filter || r.url.includes(filter)),
      );
      if (mode === 'requests') requests = requests.slice(-50);
    }
    if (mode === 'problems' || mode === 'console')
      console = fresh(this.console, seenConsole).filter(
        (c) =>
          mode === 'console' || c.level === 'error' || c.level === 'warning',
      );
    if (!filter) this.seen[mode] = [this.seq, this.consoleSeq];
    return {
      mode,
      ...(mode !== 'console' && { requests }),
      ...(mode !== 'requests' && { console }),
      note: `${all ? 'Everything recorded' : 'New since the last logs call'}; ${this.requests.length} requests and ${this.console.length} console messages recorded since ${new Date(this.since).toISOString().slice(11, 19)} UTC.${all ? '' : ' full:true for all.'}`,
    };
  }
  async detail(n, signal) {
    const entry = this.requests.find((r) => r.n === n);
    if (!entry)
      throw new Error(
        `Request #${n} is no longer recorded; list requests again.`,
      );
    let body = '';
    if (!entry.done) body = '(still loading)';
    else
      try {
        const r = await this.cdp.call(
          'Network.getResponseBody',
          { requestId: entry.id },
          signal,
          entry.sid,
        );
        const raw = r.base64Encoded
          ? Buffer.from(r.body, 'base64')
          : Buffer.from(r.body ?? '');
        body =
          entry.mime && !TEXTUAL.test(entry.mime)
            ? `(binary, ${raw.length} bytes)`
            : raw.toString('utf8').slice(0, MAX_BODY) +
              (raw.length > MAX_BODY ? '\n… (truncated)' : '');
      } catch {
        body =
          '(body unavailable: not kept by the browser, or the page navigated away)';
      }
    if (!entry.postData && entry.hasPostData)
      entry.postData = await this.cdp
        .call(
          'Network.getRequestPostData',
          { requestId: entry.id },
          signal,
          entry.sid,
        )
        .then((r) => r.postData?.slice(0, MAX_POST))
        .catch(() => undefined);
    return { request: entry, body };
  }
}
