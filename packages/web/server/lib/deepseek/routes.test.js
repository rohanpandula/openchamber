import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { OpenCode } from '@opencode/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Identifier } from '@opencode/schema/identifier';
import { createDeepSeekIntegration } from './routes.js';

const cleanups = [];
afterEach(async () => {
  delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const listen = async (app) => {
  const server = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
};
async function fixture() {
  const sessions = new Map();
  const native = express();
  native.use(express.json());
  native.get('/api/provider', (_req, res) => res.json({ location: { directory: '/tmp' }, data: [] }));
  native.get('/api/model', (_req, res) => res.json({ location: { directory: '/tmp' }, data: [] }));
  native.post('/api/session', (req, res) => {
    const info = { ...req.body, projectID: 'project_test', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } };
    sessions.set(info.id, info); res.json({ data: info });
  });
  native.get('/api/session/active', (_req, res) => res.json({ data: {} }));
  native.get('/api/permission/request', (_req, res) => res.json({ data: [] }));
  native.get('/api/session/:id', (req, res) => res.json({ data: sessions.get(req.params.id) }));
  native.patch('/api/session/:id', (req, res) => { Object.assign(sessions.get(req.params.id), req.body); res.sendStatus(204); });
  native.delete('/api/session/:id', (req, res) => { sessions.delete(req.params.id); res.sendStatus(204); });
  const nativeUrl = await listen(native);
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-v2-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const events = [];
  const integration = createDeepSeekIntegration({
    dataDir: directory, buildOpenCodeUrl: () => nativeUrl, getOpenCodeAuthHeaders: () => ({}), publish: (event) => events.push(event),
    env: { ...process.env, DEEPSEEK_DSH_BIN: process.execPath, DEEPSEEK_DSH_ARGS: fileURLToPath(new URL('./fixtures/fake-dsh-acp.mjs', import.meta.url)) },
  });
  cleanups.push(() => integration.stop());
  const app = express();
  // The real server leaves prompt bodies unparsed for the upstream stream.
  app.use((req, res, next) => req.path.endsWith('/prompt') ? next() : express.json()(req, res, next));
  integration.register(app);
  app.use((_req, res) => res.sendStatus(404));
  const url = await listen(app);
  const post = (suffix, body) => fetch(url + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const create = (id) => post('/api/session', { id, title: 'test', location: { directory }, model: { providerID: 'deepseek-harness', id: 'deepseek-v4-flash' } });
  return { url, post, create, events, sessions, integration };
}
const eventually = async (predicate) => {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error('Expected state did not arrive');
};
describe('DeepSeek routes on the current OpenCode API', () => {
  it('keeps the native session index and runs a prompt only through ACP', async () => {
    const f = await fixture();
    const created = await f.create(); expect(created.status).toBe(200);
    const { data: session } = await created.json();
    expect(session.id).toMatch(/^ses_dsh_/);
    expect(f.sessions.has(session.id)).toBe(true);
    const promptId = `msg_${Identifier.ascending()}`;
    const sent = await f.post(`/api/session/${session.id}/prompt`, { id: promptId, text: 'say hi' });
    expect(sent.status).toBe(200);
    await eventually(() => f.events.some((event) => event.payload.type === 'session.execution.succeeded'));
    const messages = await (await fetch(`${f.url}/api/session/${session.id}/message`)).json();
    expect(messages.data[0].type).toBe('assistant');
    expect(messages.data[0].content.some((part) => part.type === 'text' && part.text.includes('Hello'))).toBe(true);
    expect(messages.data[1].id).toBe(promptId);
    expect(messages.data[0].id > promptId).toBe(true);
    expect(messages.data[0].time.created >= messages.data[1].time.created).toBe(true);
    const sdk = OpenCode.make({ baseUrl: f.url });
    const first = await sdk.message.list({ sessionID: session.id, limit: 1 });
    expect(first.cursor.next).toBe(messages.data[0].id);
    const older = await sdk.message.list({ sessionID: session.id, limit: 1, cursor: first.cursor.next });
    expect(older.data.map((message) => message.id)).toEqual([promptId]);
    expect(older.cursor.next).toBeUndefined();
    expect(f.events.some((event) => event.payload.type === 'session.text.delta')).toBe(true);
    expect((await f.post(`/api/session/${session.id}/shell`, { command: 'echo nope' })).status).toBe(501);
  });
  it('preserves the client-generated session id used by optimistic UI state', async () => {
    const f = await fixture();
    const response = await f.create('ses_client');
    expect(response.status).toBe(200);
    expect((await response.json()).data.id).toBe('ses_client');
    expect((await f.post('/api/session/ses_client/prompt', { text: 'hi' })).status).toBe(200);
  });
  it('delivers queued text and context through the existing Harness session', async () => {
    const f = await fixture();
    const { data: session } = await (await f.create()).json();
    const dispatch = await f.integration.getSessionDispatch(session.id);
    expect(await dispatch.isIdle()).toBe(true);
    await dispatch.send({ id: 'queued_test', text: 'queued hello', context: [{ text: 'context' }], attachments: [],
      sendConfig: { providerID: 'deepseek-harness', modelID: 'deepseek-v4-flash', agent: 'build' } });
    await eventually(() => f.events.some((event) => event.payload.type === 'session.execution.succeeded'));
    const messages = await (await fetch(`${f.url}/api/session/${session.id}/message`)).json();
    expect(messages.data.find((message) => message.id === 'msg_queue_queued_test').text).toContain('queued hello');
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    await expect(dispatch.send({ sendConfig: {} })).rejects.toThrow('not available');
  });
  it('round-trips a permission through the v2 endpoint', async () => {
    const f = await fixture();
    const { data: session } = await (await f.create()).json();
    await f.post(`/api/session/${session.id}/prompt`, { text: 'needs permission' });
    await eventually(() => f.events.some((event) => event.payload.type === 'permission.asked'));
    const asked = f.events.find((event) => event.payload.type === 'permission.asked').payload.data;
    const pending = await (await fetch(`${f.url}/api/session/${session.id}/permission`)).json();
    expect(pending.data[0].id).toBe(asked.id);
    expect((await f.post(`/api/session/${session.id}/permission/${asked.id}/reply`, { decision: 'once' })).status).toBe(204);
    await eventually(() => f.events.some((event) => event.payload.type === 'session.execution.succeeded'));
  });
  it('refuses enterprise egress at the point of execution', async () => {
    const f = await fixture();
    const { data: session } = await (await f.create()).json();
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    expect((await f.create()).status).toBe(403);
    expect((await f.post(`/api/session/${session.id}/prompt`, { text: 'hello' })).status).toBe(403);
    expect(f.events.some((event) => event.payload.type === 'session.text.delta')).toBe(false);
  });
  it('exposes the configured model and rejects unconfigured selections', async () => {
    const f = await fixture();
    const models = await (await fetch(`${f.url}/api/model`)).json();
    expect(models.data[0].providerID).toBe('deepseek-harness');
    expect((await f.post('/api/session', { model: { providerID: 'deepseek-harness', id: 'other' } })).status).toBe(400);
  });
});
