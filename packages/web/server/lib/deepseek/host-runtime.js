import path from 'node:path';
import { z } from 'zod';
import { createHostConnection } from './host-connection.js';
import { createHostTranscript, hostEventSchema, hostSessionID, fromHostSessionID } from './host-transcript.js';

const rowSchema = z.object({
  sessionId: z.string().min(1), updatedAt: z.number(), running: z.boolean(),
  cwd: z.string().refine(path.isAbsolute, 'Expected an absolute Harness directory').optional(), origin: z.string().optional(),
  projections: z.object({ values: z.record(z.string(), z.unknown()) }).optional(),
});
const snapshotSchema = z.object({
  type: z.literal('snapshot'), cursor: z.number(), hasMore: z.boolean(),
  records: z.array(z.object({ event: hostEventSchema })),
  assistantStream: z.object({ activeAttempt: z.unknown().optional() }).optional(),
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createSharedHostRuntime({ file, model, provider, publishEvent, onSession, onStatus, onError = () => {}, loadSessionBindings = async () => new Map(), connectionFactory = createHostConnection }) {
  const sessions = new Map();
  const histories = new Map();
  const wantedHistories = new Set();
  const historyRetries = new Map();
  const historyFailures = new Map();
  let indexRetry;
  let indexFailures = 0;
  let initialized = false;
  let stopped = false;
  let refreshPromise;
  let refreshGeneration;
  let refreshAgain = false;
  let generation = 0;
  let sessionBindings;
  const nativeID = (id) => sessionBindings?.get(id) || hostSessionID(id);
  const connection = connectionFactory({
    file,
    onError,
    onReady: () => refresh(),
    onDisconnect: () => {
      generation++;
      initialized = false;
      for (const history of histories.values()) history.cancel?.();
      histories.clear();
      clearTimeout(indexRetry);
      indexRetry = undefined;
      for (const timer of historyRetries.values()) clearTimeout(timer);
      historyRetries.clear();
    },
    onEvent(event) {
      if (event?.type !== 'emit') return;
      if (event.event === 'api-session/status') {
        const [id, running] = event.args;
        const session = sessions.get(nativeID(id));
        if (session && z.boolean().safeParse(running).success) {
          session.running = running;
          onStatus(session, running);
          if (running) void historyFor(session.id).catch(onError);
        }
      } else if (['api-session/added', 'api-session/removed', 'api-session/activity'].includes(event.event)) {
        void refresh().catch(onError);
      } else if (event.event === 'api-session/error') {
        const session = sessions.get(nativeID(event.args[0]));
        if (session) publishEvent({ directory: session.directory, payload: { type: 'session.error', properties: { sessionID: session.id, error: { message: String(event.args[1]) } } } });
      }
    },
  });

  async function refresh() {
    if (refreshPromise && refreshGeneration === generation) { refreshAgain = true; return refreshPromise; }
    const current = generation;
    refreshGeneration = current;
    const operation = (async () => {
      do {
        refreshAgain = false;
        sessionBindings ||= await loadSessionBindings();
        const result = z.object({ items: z.array(rowSchema) }).parse(await connection.call('session/list', { _request: {} }));
        if (current !== generation || stopped) return;
        let indexFailed = false;
        for (const row of [...result.items].sort((a, b) => a.updatedAt - b.updatedAt)) {
          if (current !== generation || stopped) return;
          if (row.origin === 'subagent' || !row.cwd) continue;
          const values = row.projections?.values || {};
          const id = nativeID(row.sessionId);
          const previous = sessions.get(id);
          const session = { id, hostID: row.sessionId, directory: row.cwd, title: z.string().safeParse(values.title).data || 'DeepSeek session',
            time: { created: previous?.time.created || row.updatedAt, updated: row.updatedAt }, running: row.running };
          sessions.set(id, session);
          try { await onSession(session, () => current === generation && !stopped); } catch (error) { indexFailed = true; onError(error); continue; }
          if (current !== generation || stopped) return;
          if (previous ? previous.running !== session.running : session.running) onStatus(session, session.running);
        }
        if (current !== generation || stopped) return;
        initialized = true;
        if (indexFailed && !indexRetry) {
          indexRetry = setTimeout(() => { indexRetry = undefined; void refresh().catch(onError); }, Math.min(30000, 500 * 2 ** Math.min(indexFailures++, 6)));
          indexRetry.unref?.();
        } else if (!indexFailed) indexFailures = 0;
        for (const session of sessions.values()) if (session.running || wantedHistories.has(session.id)) void historyFor(session.id).catch(onError);
      } while (refreshAgain && current === generation && !stopped);
    })();
    refreshPromise = operation;
    try { await operation; } finally { if (refreshPromise === operation) refreshPromise = undefined; }
  }
  async function ready() {
    for (let i = 0; i < 150 && !initialized && !stopped; i++) await sleep(100);
    if (!initialized || !connection.isReady()) throw Object.assign(new Error('DeepSeek Harness is disconnected. Open Harness to reconnect.'), { code: 'HOST_UNAVAILABLE' });
  }
  async function historyFor(id) {
    wantedHistories.add(id);
    if (histories.has(id)) return histories.get(id).promise;
    const session = sessions.get(id);
    if (!session) throw new Error('DeepSeek session not found');
    const current = generation;
    const transcript = createHostTranscript({ sessionID: id, directory: session.directory, publish: publishEvent });
    const pending = [];
    const history = { transcript, loaded: false };
    histories.set(id, history);
    history.promise = new Promise((resolve, reject) => {
      const fail = (error) => {
        history.cancel?.();
        const active = histories.get(id) === history;
        if (active) histories.delete(id);
        reject(error);
        if (!active || stopped || current !== generation || !connection.isReady() || historyRetries.has(id)) return;
        const failures = historyFailures.get(id) || 0;
        historyFailures.set(id, failures + 1);
        const timer = setTimeout(() => { historyRetries.delete(id); void historyFor(id).catch(onError); }, Math.min(30000, 500 * 2 ** Math.min(failures, 6)));
        timer.unref?.();
        historyRetries.set(id, timer);
        if (history.loaded) onError(error);
      };
      history.cancel = connection.stream('session/follow', { request: { address: { kind: 'session', sessionId: session.hostID }, assistantStream: true, maxMessages: 100 } }, (raw) => {
        if (current !== generation || histories.get(id) !== history) return;
        if (raw?.type === 'snapshot') {
          void (async () => {
            const snapshot = snapshotSchema.parse(raw);
            let records = snapshot.records;
            let more = snapshot.hasMore;
            while (more) {
              const page = z.object({ records: z.array(z.object({ event: hostEventSchema })), hasMore: z.boolean() }).parse(await connection.call('session/page', { request: {
                address: { kind: 'session', sessionId: session.hostID }, throughSeq: snapshot.cursor, beforeSeq: records[0].event.seq, maxMessages: 500,
              } }));
              if (!page.records.length) throw new Error('DeepSeek history pagination made no progress');
              records = [...page.records, ...records];
              more = page.hasMore;
            }
            if (current !== generation || histories.get(id) !== history) throw new Error('DeepSeek connection changed while loading history');
            for (const record of records) transcript.accept(record.event);
            transcript.baseline(snapshot.assistantStream?.activeAttempt);
            history.loaded = true;
            historyFailures.delete(id);
            for (const frame of pending) accept(frame);
            pending.length = 0;
            resolve(transcript);
          })().catch(fail);
        } else if (!history.loaded) pending.push(raw);
        else {
          try { accept(raw); } catch (error) { history.cancel(); fail(error); }
        }
      }, fail);
      function accept(frame) {
        if (frame?.type === 'event') transcript.accept(frame.event, true);
        else if (frame?.type === 'assistant-stream') transcript.frame(frame.frame);
      }
    });
    return history.promise;
  }
  connection.start();
  return {
    owns: (id) => sessions.has(id) || fromHostSessionID(id) !== null,
    isAvailable: () => true,
    async getSession({ sessionID }) { await ready(); return sessions.get(sessionID) || null; },
    async getMessages({ sessionID }) { await ready(); return (await historyFor(sessionID)).records(); },
    async createSession(input) {
      await ready();
      const created = z.object({ sessionId: z.string() }).parse(await connection.call('session/create', { request: { cwd: input.directory, sessionId: input.id } }));
      if (model && provider) await connection.call('session/selectModel', { request: { sessionId: created.sessionId, provider, model } });
      if (input.title) await connection.call('session/rename', { request: { sessionId: created.sessionId, title: input.title } });
      await refresh();
      return sessions.get(nativeID(created.sessionId));
    },
    async promptAsync({ sessionID, messageID, parts }) {
      await ready();
      await historyFor(sessionID);
      return connection.call('session/prompt', { request: { sessionId: sessions.get(sessionID)?.hostID || fromHostSessionID(sessionID), requestId: messageID, mode: 'queue',
        content: parts.map((part) => part.type === 'file' ? { type: 'image', mediaType: part.mime, data: part.url.split(',')[1], name: part.filename } : { type: 'text', text: part.text }),
      } });
    },
    async abortSession({ sessionID }) { await ready(); return connection.call('session/cancel', { request: { sessionId: sessions.get(sessionID)?.hostID || fromHostSessionID(sessionID) } }); },
    async updateSession({ sessionID, title }) { await ready(); await connection.call('session/rename', { request: { sessionId: sessions.get(sessionID)?.hostID || fromHostSessionID(sessionID), title } }); await refresh(); },
    async deleteSession() { throw new Error('Delete or archive shared Harness sessions in Harness.'); },
    async getStatusSnapshot() { await ready(); return { busySessions: [...sessions.values()].filter((s) => s.running).map((s) => s.id) }; },
    async listPendingPermissions() { return []; },
    shutdownAll() { stopped = true; clearTimeout(indexRetry); for (const timer of historyRetries.values()) clearTimeout(timer); historyRetries.clear(); connection.stop(); histories.clear(); },
  };
}
