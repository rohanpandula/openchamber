import { describe, expect, it } from 'vitest';
import { createSharedHostRuntime } from './host-runtime.js';

const workspaceStream = (_method, _args, receive) => { receive({ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }); return () => {}; };
const row = (sessionId, extra = {}) => ({ sessionId, cwd: '/tmp', updatedAt: 1, running: false, ...extra });

describe('shared Harness session membership', () => {
  it('indexes only top-level chats; subagents remain in the parent transcript', async () => {
    const indexed = [];
    const calls = [];
    const runtime = createSharedHostRuntime({ file: 'unused', publishEvent: () => {}, onStatus: () => {}, onSession: async (s) => indexed.push(s),
      connectionFactory: (options) => ({
        start() { queueMicrotask(() => options.onReady()); }, isReady: () => true, stream: workspaceStream, stop() {},
        async call(method) { calls.push(method); return { items: [row('root'), row('child', { origin: 'subagent', parentSessionId: 'root' }), row('fork', { parentSessionId: 'root' })] }; },
      }),
    });
    try {
      await runtime.getStatusSnapshot();
      expect(indexed.map((s) => s.hostID)).toEqual(['root', 'fork']);
      expect(calls).toEqual(['session/list']);
    } finally { runtime.shutdownAll(); }
  });
  it('does not run another agent or erase other chats when one index write fails', async () => {
    const indexed = [];
    const errors = [];
    const runtime = createSharedHostRuntime({ file: 'unused', publishEvent: () => {}, onStatus: () => {}, onError: (e) => errors.push(e.message),
      onSession: async (s) => { if (s.hostID === 'bad') throw Error('cannot index'); indexed.push(s.hostID); },
      connectionFactory: (options) => ({ start() { queueMicrotask(() => options.onReady()); }, isReady: () => true, stream: workspaceStream, stop() {},
        async call() { return { items: [row('bad'), row('good')] }; },
      }),
    });
    try { await runtime.getStatusSnapshot(); expect(indexed).toEqual(['good']); expect(errors).toEqual(['cannot index']); }
    finally { runtime.shutdownAll(); }
  });
});

it('starts a fresh list after reconnect even while the old list is pending', async () => {
  let callbacks;
  let finishOld;
  let calls = 0;
  const indexed = [];
  const runtime = createSharedHostRuntime({ file: 'unused', publishEvent: () => {}, onStatus: () => {}, onSession: async (s) => indexed.push(s.hostID),
    connectionFactory: (options) => {
      callbacks = options;
      return { start() {}, stop() {}, isReady: () => true, stream: workspaceStream,
        call() { calls++; return calls === 1 ? new Promise((resolve) => { finishOld = resolve; }) : Promise.resolve({ items: [row('new')] }); },
      };
    },
  });
  try {
    const old = callbacks.onReady();
    while (!finishOld) await Promise.resolve();
    callbacks.onDisconnect();
    await callbacks.onReady();
    finishOld({ items: [row('stale')] });
    await old;
    expect(calls).toBe(2);
    expect(indexed).toEqual(['new']);
  } finally { runtime.shutdownAll(); }
});

it('reuses the native ID of a legacy ACP chat instead of importing a duplicate', async () => {
  const indexed = [];
  const runtime = createSharedHostRuntime({ file: 'unused', publishEvent: () => {}, onStatus: () => {}, onSession: async (session) => indexed.push(session.id),
    loadSessionBindings: async () => new Map([['old-host-id', 'ses_existing']]),
    connectionFactory: (options) => ({ start() { queueMicrotask(() => options.onReady()); }, stop() {}, isReady: () => true, stream: workspaceStream,
      async call() { return { items: [row('old-host-id')] }; },
    }),
  });
  try {
    await runtime.getStatusSnapshot();
    expect(indexed).toEqual(['ses_existing']);
    expect(runtime.owns('ses_existing')).toBe(true);
    expect((await runtime.getSession({ sessionID: 'ses_existing' })).hostID).toBe('old-host-id');
  } finally { runtime.shutdownAll(); }
});

it('uses Harness workspace membership rather than a chat working directory', async () => {
  const indexed = [];
  const runtime = createSharedHostRuntime({ file: 'unused', publishEvent: () => {}, onStatus: () => {}, onSession: async (s) => indexed.push(s),
    connectionFactory: (options) => ({ start() { queueMicrotask(() => options.onReady()); }, stop() {}, isReady: () => true,
      stream(_method, _args, receive) { receive({ type: 'baseline', value: { items: [{ workspaceId: 'workspace', path: '/workspace', title: 'My workspace', sessionIds: ['member'] }], archivedSessionIds: [], pinnedSessionIds: [] } }); return () => {}; },
      async call() { return { items: [row('member', { cwd: '/outside/tools' }), row('loose', { cwd: '/workspace' })] }; },
    }),
  });
  try {
    await runtime.getStatusSnapshot();
    expect(indexed[0]).toMatchObject({ directory: '/outside/tools', workspace: { id: 'workspace', path: '/workspace', title: 'My workspace', order: 0 } });
    expect(indexed[1].workspace).toBeNull();
  } finally { runtime.shutdownAll(); }
});


it('hydrates image attachments for a handoff without losing their session ownership', async () => {
  const calls = [];
  const runtime = createSharedHostRuntime({ file: 'unused', publishEvent: () => {}, onStatus: () => {}, onSession: async () => {},
    connectionFactory: (options) => ({ start() { queueMicrotask(() => options.onReady()); }, stop() {}, isReady: () => true,
      stream(method, args, receive) {
        if (method === 'workspace/follow') return workspaceStream(method, args, receive);
        receive({ type: 'snapshot', cursor: 1, hasMore: false, records: [{ event: { type: 'user/message', seq: 1, time: 1, data: {
          source: { kind: 'user' }, content: [{ type: 'text', text: 'What color?' }, { type: 'image', attachment: { attachmentId: 'img_test', mediaType: 'image/png' } }],
        } } }] });
        return () => {};
      },
      async call(method, args) {
        if (method === 'session/list') return { items: [row('ses_test')] };
        calls.push({ method, args });
        return { attachment: { mediaType: 'image/png', name: 'test.png' }, data: 'aGVsbG8=' };
      },
    }),
  });
  try {
    const records = await runtime.getExportMessages({ sessionID: 'ses_test' });
    expect(records[0].parts.at(-1)).toMatchObject({ type: 'file', mime: 'image/png', url: 'data:image/png;base64,aGVsbG8=' });
    expect(calls).toEqual([{ method: 'session/attachment', args: { request: { sessionId: 'ses_test', attachmentId: 'img_test' } } }]);
  } finally { runtime.shutdownAll(); }
});


it.each([false, true])('handles a question replay during startup (cancelled: %s)', async (cancelled) => {
  let callbacks, completeList;
  const runtime = createSharedHostRuntime({ file: 'unused', publishEvent: () => {}, onStatus: () => {}, onSession: async () => {},
    connectionFactory: (options) => {
      callbacks = options;
      return { start() {}, stop() {}, isReady: () => true, stream: workspaceStream,
        call: () => completeList ? Promise.resolve({ items: [row('ses_test')] }) : new Promise((resolve) => { completeList = resolve; }),
      };
    },
  });
  try {
    const loading = callbacks.onReady();
    const answering = callbacks.onInteraction({ event: 'user-questions/request', agentId: 'ses_test', eventId: 'startup', request: { questions: [{ id: 'color', question: 'Which color?' }] } }, async () => {});
    if (cancelled) callbacks.onEvent({ type: 'cancel', eventId: 'startup' });
    while (!completeList) await Promise.resolve();
    completeList({ items: [row('ses_test')] });
    await loading;
    expect(await answering).toBe(true);
    expect(await runtime.listPendingForms()).toHaveLength(cancelled ? 0 : 1);
  } finally { runtime.shutdownAll(); }
});
