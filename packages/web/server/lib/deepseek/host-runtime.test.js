import { describe, expect, it } from 'vitest';
import { createSharedHostRuntime } from './host-runtime.js';

const row = (sessionId, extra = {}) => ({ sessionId, cwd: '/tmp', updatedAt: 1, running: false, ...extra });

describe('shared Harness session membership', () => {
  it('indexes only top-level chats; subagents remain in the parent transcript', async () => {
    const indexed = [];
    const calls = [];
    const runtime = createSharedHostRuntime({ file: 'unused', publishEvent: () => {}, onStatus: () => {}, onSession: async (s) => indexed.push(s),
      connectionFactory: (options) => ({
        start() { queueMicrotask(() => options.onReady()); }, isReady: () => true, stop() {},
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
      connectionFactory: (options) => ({ start() { queueMicrotask(() => options.onReady()); }, isReady: () => true, stop() {},
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
      return { start() {}, stop() {}, isReady: () => true,
        call() { calls++; return calls === 1 ? new Promise((resolve) => { finishOld = resolve; }) : Promise.resolve({ items: [row('new')] }); },
      };
    },
  });
  try {
    const old = callbacks.onReady();
    await Promise.resolve();
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
    connectionFactory: (options) => ({ start() { queueMicrotask(() => options.onReady()); }, stop() {}, isReady: () => true,
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
