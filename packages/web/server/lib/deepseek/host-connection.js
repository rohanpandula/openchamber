import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';

const discoverySchema = z.object({ version: z.literal(1), pid: z.number().int().positive(), url: z.string().url() });
const resultSchema = z.object({ type: z.literal('server-response'), rpcId: z.string(), result: z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]) });
const frameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('item'), streamId: z.string(), value: z.unknown().optional() }),
  z.object({ type: z.literal('end'), streamId: z.string() }),
  z.object({ type: z.literal('error'), streamId: z.string(), error: z.object({ message: z.string() }) }),
]);

// Credentials stay here, never in OpenChamber responses or event payloads.
export function createHostConnection({ file, onReady, onDisconnect, onEvent, onInteraction, onError = () => {}, fetchImpl = fetch }) {
  let socket;
  let endpoint;
  let cookie;
  let stopped = false;
  let ready = false;
  let retry;
  let failures = 0;
  let opening;
  const streams = new Map();
  const lifetime = new AbortController();
  const unavailable = () => Object.assign(new Error('DeepSeek Harness is disconnected. Open Harness and try again.'), { code: 'HOST_UNAVAILABLE' });

  function stream(method, args, receive, failed = () => {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw unavailable();
    const streamId = randomUUID();
    streams.set(streamId, { receive, failed });
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: method, payload: { args } }));
    return () => {
      if (!streams.delete(streamId)) return;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', streamId }));
    };
  }

  async function call(method, args) {
    if (!ready) throw unavailable();
    const rpcId = randomUUID();
    const response = await fetchImpl(new URL(`/api/${method}`, endpoint), {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30000)]), redirect: 'error',
    });
    if (!response.ok) throw Object.assign(new Error(`DeepSeek Harness request failed (${response.status})`), { code: 'HOST_UNAVAILABLE' });
    const envelope = resultSchema.parse(await response.json());
    if (envelope.rpcId !== rpcId) throw new Error('DeepSeek Harness returned a mismatched response');
    if (!envelope.result.ok) throw Object.assign(new Error(envelope.result.error.message), { code: envelope.result.error.code });
    return envelope.result.value;
  }

  async function connect() {
    if (stopped) return;
    try {
      const stat = await fs.stat(file);
      if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) throw new Error('DeepSeek connection file must be private to this user');
      const discovery = discoverySchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
      endpoint = new URL(discovery.url);
      if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/' || !endpoint.searchParams.get('token') || endpoint.username || endpoint.password) throw new Error('Invalid local DeepSeek host');
      const url = new URL('/connect', endpoint);
      url.search = endpoint.search;
      url.searchParams.set('interactions', 'answer');
      const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]) });
      if (response.status !== 302 || !response.headers.get('set-cookie')) throw unavailable();
      cookie = response.headers.get('set-cookie').split(';')[0];
      const target = new URL('/api/remote.mux', endpoint);
      target.protocol = 'ws:';
      endpoint.search = '';
      const current = new WebSocket(target, { headers: { Cookie: cookie }, maxPayload: 64 * 1024 * 1024, handshakeTimeout: 5000 });
      socket = current;
      current.on('error', () => current.close());
      current.on('close', () => {
        if (socket !== current) return;
        socket = undefined;
        cookie = undefined;
        ready = false;
        for (const entry of streams.values()) entry.failed(unavailable());
        streams.clear();
        onDisconnect?.();
        schedule();
      });
      current.on('message', (data) => {
        try {
          const frame = frameSchema.parse(JSON.parse(data.toString()));
          const entry = streams.get(frame.streamId);
          if (!entry) return;
          if (frame.type === 'item') entry.receive(frame.value);
          else {
            streams.delete(frame.streamId);
            entry.failed(new Error(frame.type === 'error' ? frame.error.message : 'DeepSeek stream ended'));
          }
        } catch {
          current.close();
        }
      });
      current.on('open', () => {
        let clientId;
        stream('$events', {}, (event) => {
          if (event?.type === 'ready') {
            clientId = event.clientId;
            ready = true;
            Promise.resolve(onReady?.()).then(() => { failures = 0; }).catch((error) => { onError(error); current.close(); });
          } else if (event?.type === 'waterfall') {
            const respond = (outcome) => call('$events/result', { clientId, eventId: event.eventId, outcome });
            void Promise.resolve(onInteraction?.(event, respond))
              .then((handled) => handled || respond({ kind: 'next' }))
              .catch(() => current.close());
          } else onEvent?.(event);
        }, () => current.close());
      });
    } catch {
      ready = false;
      onDisconnect?.();
      schedule();
    }
  }
  function schedule() {
    if (stopped || retry) return;
    const delay = Math.min(30000, 500 * 2 ** Math.min(failures++, 6));
    retry = setTimeout(() => { retry = undefined; opening = connect(); }, delay);
    retry.unref?.();
  }
  return {
    start() { if (!opening) opening = connect(); return opening; },
    call, stream,
    isReady: () => ready,
    reconnect: () => socket?.close(),
    stop() { stopped = true; clearTimeout(retry); lifetime.abort(); socket?.close(); streams.clear(); },
  };
}
