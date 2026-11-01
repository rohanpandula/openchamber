import express from 'express';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createOpenCodeClient } from '../openchamber-sessions/opencode-client.js';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { createDeepSeekBackendRuntime } from './deepseek-backend.js';
import { createEventBridge, messageInfo, modelInfo, permissionInfo, providerInfo, PROVIDER_ID } from './wire.js';

const modelSchema = z.object({ providerID: z.literal(PROVIDER_ID), id: z.string().min(1) });
const createSchema = z.object({
  id: z.string().startsWith('ses_').optional(), title: z.string().optional(),
  model: modelSchema, location: z.object({ directory: z.string().min(1) }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const promptSchema = z.object({
  id: z.string().startsWith('msg_').optional(), text: z.string(),
  files: z.array(z.object({ data: z.string(), mime: z.string().startsWith('image/'), name: z.string().optional() })).optional(),
  skills: z.array(z.unknown()).optional(), agents: z.array(z.unknown()).optional(),
});
const sessionPrefix = 'ses_dsh_';

export function createDeepSeekIntegration({ dataDir, buildOpenCodeUrl, getOpenCodeAuthHeaders, publish, env = process.env }) {
  const modelId = env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
  const model = { providerID: PROVIDER_ID, id: modelId };
  const client = (directory) => createOpenCodeClient({ baseUrl: buildOpenCodeUrl('', ''), headers: getOpenCodeAuthHeaders(), directory });
  const runtime = createDeepSeekBackendRuntime({
    crypto, fsPromises: fs, env,
    sessionsFilePath: path.join(dataDir, 'deepseek-sessions.json'),
    publishEvent: createEventBridge({ publish, modelId, onSessionUpdated: (session) => {
      void client(session.directory).session.update({ sessionID: session.id, title: session.title }).catch((error) => {
        console.warn('[deepseek] Could not update session title:', error.message);
      });
    } }),
  });
  const enabled = () => Boolean(env.DEEPSEEK_DSH_BIN && runtime.isAvailable() && !isEnterpriseMode());
  const decorateSession = (info) => info?.metadata?.openchamberBackend === 'deepseek' ? { ...info, model } : info;
  const canRun = (res) => {
    if (isEnterpriseMode()) { res.status(403).json({ code: 'enterprise_mode', error: 'DeepSeek Harness is disabled in enterprise mode.' }); return false; }
    if (!enabled()) { res.status(503).json({ error: 'DeepSeek Harness is not available.' }); return false; }
    return true;
  };
  const directoryOf = (req) => {
    const raw = req.get('x-opencode-directory');
    return raw ? decodeURIComponent(raw) : undefined;
  };
  const guard = (handler) => async (req, res, next) => {
    try { await handler(req, res, next); }
    catch (error) {
      if (res.headersSent) return next(error);
      res.status(error instanceof z.ZodError ? 400 : error.code === 'SESSION_BUSY' ? 409 : 500).json({ error: error.message });
    }
  };
  const nativeSession = async (id) => client().session.get({ sessionID: id });


  function register(app) {
    app.get('/api/provider', guard(async (req, res, next) => {
      if (!enabled()) return next();
      const result = await client(directoryOf(req)).provider.list();
      res.json({ ...result, data: [...result.data, providerInfo] });
    }));
    app.get('/api/model', guard(async (req, res, next) => {
      if (!enabled()) return next();
      const result = await client(directoryOf(req)).model.list({ types: ['chat', 'image'] });
      res.json({ ...result, data: [...result.data, modelInfo(modelId)] });
    }));
    app.post('/api/session', guard(async (req, res, next) => {
      if (req.body?.model?.providerID !== PROVIDER_ID) return next();
      if (!canRun(res)) return;
      const input = createSchema.parse(req.body);
      if (input.model.id !== modelId) return res.status(400).json({ error: 'This model is not configured in DeepSeek Harness.' });
      const native = await client(input.location?.directory || directoryOf(req)).session.create({
        id: input.id || `${sessionPrefix}${crypto.randomUUID()}`, title: input.title,
        location: input.location, metadata: { ...input.metadata, openchamberBackend: 'deepseek', openchamberDeepSeekModel: modelId },
      });
      try {
        await runtime.createSession({ id: native.id, projectID: native.projectID, directory: native.location.directory, title: native.title });
      } catch (error) {
        await client().session.remove({ sessionID: native.id }).catch(() => {});
        throw error;
      }
      res.json({ data: decorateSession(native) });
    }));
    app.get('/api/session/active', guard(async (_req, res, next) => {
      if (!enabled()) return next();
      const active = await client().session.active();
      const snapshot = await runtime.getStatusSnapshot();
      for (const id of snapshot.busySessions) active[id] = { type: 'running' };
      res.json({ data: active });
    }));
    app.get('/api/permission/request', guard(async (req, res, next) => {
      if (!enabled()) return next();
      const result = await client(directoryOf(req)).permission.request.list();
      const pending = await runtime.listPendingPermissions();
      res.json({ ...result, data: [...result.data, ...pending.map(permissionInfo)] });
    }));
    app.use('/api/session/:sessionID', guard(async (req, res, next) => {
      const id = req.params.sessionID;
      const session = await runtime.getSession({ sessionID: id });
      if (!session) {
        if (!enabled()) return next();
        const native = await nativeSession(id);
        if (native?.metadata?.openchamberBackend !== 'deepseek') return next();
        throw new Error('DeepSeek transcript is unavailable; the session cannot run.');
      }
      req.deepSeekSession = session;
      return express.json({ limit: '12mb' })(req, res, next);
    }), guard(async (req, res, next) => {
      const id = req.params.sessionID;
      const session = req.deepSeekSession;
      if (!session) return next();
      const suffix = req.path;
      if (req.method === 'GET' && suffix === '/') {
        return res.json({ data: decorateSession(await nativeSession(id)) });
      }
      if (req.method === 'GET' && /^\/message(?:\/|$)/.test(suffix)) {
        const records = (await runtime.getMessages({ sessionID: id })).map((record) => messageInfo(record, modelId));
        const messageId = suffix.split('/')[2];
        if (messageId) {
          const message = records.find((entry) => entry.id === messageId);
          return message ? res.json({ data: message }) : res.status(404).json({ error: 'Message not found' });
        }
        const limit = z.coerce.number().int().min(1).max(1000).default(100).parse(req.query.limit);
        const ordered = req.query.order === 'asc' ? records : records.toReversed();
        const cursor = z.string().optional().parse(req.query.cursor) ?? null;
        const offset = cursor ? ordered.findIndex((entry) => entry.id === cursor) + 1 : 0;
        if (cursor && offset === 0) return res.status(400).json({ error: 'Invalid message cursor' });
        const data = ordered.slice(offset, offset + limit);
        const page = { data };
        if (offset + limit < ordered.length) page.next = data.at(-1).id;
        return res.json(page);
      }
      if (req.method === 'GET' && suffix === '/permission') {
        const pending = await runtime.listPendingPermissions(id);
        return res.json({ data: pending.map(permissionInfo) });
      }
      if (req.method === 'GET' && /^\/permission\/[^/]+$/.test(suffix)) {
        const requests = await runtime.listPendingPermissions(id);
        const request = requests.find((entry) => entry.id === suffix.split('/')[2]);
        return request ? res.json({ data: permissionInfo(request) }) : res.status(404).json({ error: 'Permission is no longer pending' });
      }
      if (req.method === 'POST' && suffix === '/prompt') {
        if (!canRun(res)) return;
        const input = promptSchema.parse(req.body);
        if (!input.text.trim() && !input.files?.length) return res.status(400).json({ error: 'Message is empty' });
        if (input.skills?.length || input.agents?.length) return res.status(400).json({ error: 'DeepSeek Harness does not support OpenCode skill or agent attachments.' });
        const messageID = input.id || `msg_${crypto.randomUUID()}`;
        await runtime.promptAsync({ sessionID: id, messageID, directory: session.directory,
          model: { providerID: env.DEEPSEEK_PROVIDER || 'deepseek-official', modelID: modelId },
          parts: [{ type: 'text', text: input.text }, ...(input.files || []).map((file) => ({ type: 'file', mime: file.mime, filename: file.name, url: `data:${file.mime};base64,${file.data}` }))],
        });
        return res.json({ data: { id: messageID } });
      }
      if (req.method === 'POST' && suffix === '/interrupt') {
        await runtime.abortSession({ sessionID: id }); return res.status(204).end();
      }
      if (req.method === 'POST' && suffix === '/model') {
        if (!canRun(res)) return;
        const selected = modelSchema.parse(req.body?.model);
        if (selected.id !== modelId) return res.status(400).json({ error: 'Start a new session to use a different backend.' });
        return res.status(204).end();
      }
      if (req.method === 'POST' && suffix === '/agent') {
        if (req.body?.agent !== 'build') return res.status(400).json({ error: 'DeepSeek Harness uses its own agent configuration.' });
        return res.status(204).end();
      }
      if (req.method === 'POST' && /^\/permission\/[^/]+\/reply$/.test(suffix)) {
        if (!canRun(res)) return;
        const decision = z.enum(['once', 'always', 'reject']).parse(req.body?.decision);
        const requestId = suffix.split('/')[2];
        const pending = await runtime.listPendingPermissions(id);
        if (!pending.some((request) => request.id === requestId)) return res.status(404).json({ error: 'Permission is no longer pending' });
        const reply = await runtime.replyToPermission({ sessionID: id, requestId, reply: decision });
        return reply.ok ? res.status(204).end() : res.status(404).json({ error: 'Permission is no longer pending' });
      }
      if (req.method === 'DELETE' && suffix === '/') {
        await client().session.remove({ sessionID: id });
        await runtime.deleteSession({ sessionID: id }); return res.status(204).end();
      }
      if (req.method === 'PATCH' && suffix === '/') {
        if (req.body.title) await runtime.updateSession({ sessionID: id, title: z.string().parse(req.body.title) });
        return next();
      }
      if (req.method === 'POST' && suffix === '/view') return next();
      if (req.method === 'GET' && suffix === '/inbox') return res.json({ data: [] });
      return res.status(501).json({ error: 'This operation is not supported by DeepSeek Harness.' });
    }));
  }
  return { register, decorateSession, runtime, stop: () => runtime.shutdownAll() };
}
