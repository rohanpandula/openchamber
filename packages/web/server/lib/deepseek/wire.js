import { z } from 'zod';
import { asNonEmptyString, isRecord } from '../shared/guards.js';
import { randomUUID } from 'node:crypto';

export const PROVIDER_ID = 'deepseek-harness';
const ZERO_TOKENS = Object.freeze({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
export const providerInfo = { id: PROVIDER_ID, name: 'DeepSeek Harness', activation: 'enabled', package: '' };
export const modelInfo = (id) => ({
  id, modelID: id, providerID: PROVIDER_ID, type: 'chat', name: id,
  capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
  variants: [], time: { released: 0 }, cost: [], status: 'active', enabled: true,
  limit: { context: 0, output: 0 },
});
const failure = (error) => ({ type: 'DeepSeekError', message: error?.message || String(error || 'DeepSeek turn failed') });
const textOutput = (value) => z.string().safeParse(value).data ?? JSON.stringify(value ?? '');
const filesOf = (parts) => parts.filter((part) => part.type === 'file').map((part) => ({ data: part.url.split(',')[1] || '', mime: part.mime, name: part.filename, source: { type: 'inline' } }));

export function messageInfo(record, modelId) {
  const { info, parts } = record;
  const time = { created: info.time.created };
  if (info.time.completed) time.completed = info.time.completed;
  if (info.role === 'user') {
    const message = { id: info.id, type: 'user', time, text: parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n') };
    const files = filesOf(parts);
    if (files.length) message.files = files;
    return message;
  }
  const message = {
    id: info.id, type: 'assistant', agent: 'build',
    model: { providerID: PROVIDER_ID, id: modelId }, time,
    content: parts.filter((part) => ['text', 'reasoning', 'tool'].includes(part.type)).map((part) => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'reasoning') return { type: 'reasoning', text: part.text, time };
      const input = isRecord(part.state.input) ? part.state.input : {};
      const content = [{ type: 'text', text: textOutput(part.state.output) }];
      const state = part.state.status === 'completed'
        ? { status: 'completed', input, content }
        : part.state.status === 'error'
          ? { status: 'error', input, error: failure(part.state.error), content }
          : { status: 'running', input, metadata: {} };
      return { type: 'tool', id: part.callID, name: part.tool, state, time };
    }),
  };
  if (info.time.completed) message.finish = info.error ? 'error' : 'stop';
  if (info.error) message.error = failure(info.error);
  return message;
}

export function permissionInfo(request) {
  return {
    id: request.id, sessionID: request.sessionID,
    action: request.permission || 'tool', resources: request.patterns || [],
    metadata: request.metadata || {},
  };
}

// Translate the fork's ACP runtime events at one boundary; the UI keeps its v2 vocabulary.
export function createEventBridge({ publish, modelId, onSessionUpdated = () => {} }) {
  const messages = new Map();
  const failed = new Set();
  const interrupted = new Set();
  const emit = (directory, type, data, created = Date.now()) => publish({
    directory, payload: { id: `evt_dsh_${randomUUID()}`, type, created, location: { directory }, data },
  });
  return ({ directory, payload }) => {
    const p = payload.properties || {};
    const sessionID = p.sessionID || p.info?.sessionID || p.part?.sessionID || p.info?.id;
    if (payload.type === 'session.updated') {
      onSessionUpdated(p.info);
      emit(directory, 'session.renamed', { sessionID: p.info.id, title: p.info.title });
    } else if (payload.type === 'session.status' && p.status.type === 'busy') {
      failed.delete(sessionID);
      interrupted.delete(sessionID);
      emit(directory, 'session.execution.started', { sessionID });
    } else if (payload.type === 'session.error') {
      failed.add(sessionID);
      emit(directory, 'session.execution.failed', { sessionID, error: failure(p.error) });
    } else if (payload.type === 'session.idle') {
      if (!failed.has(sessionID)) {
        if (interrupted.has(sessionID)) emit(directory, 'session.execution.interrupted', { sessionID, reason: 'user' });
        else emit(directory, 'session.execution.succeeded', { sessionID });
      }
      for (const [id, message] of messages) if (message.sessionID === sessionID) messages.delete(id);
    } else if (payload.type === 'permission.asked') {
      emit(directory, 'permission.asked', permissionInfo(p));
    } else if (payload.type === 'permission.replied') {
      emit(directory, 'permission.replied', { sessionID, requestID: p.requestID, reply: p.reply === 'reject' ? 'reject' : 'once' });
    } else if (payload.type === 'message.updated') {
      const info = p.info;
      if (info.role === 'user') {
        const message = messageInfo({ info, parts: p.parts || [] }, modelId);
        const userPayload = { text: message.text };
        if (message.files) userPayload.files = message.files;
        emit(directory, 'session.inbox.enqueued', { sessionID, inboxID: info.id, item: { type: 'user', delivery: 'queue', payload: userPayload } }, info.time.created);
        emit(directory, 'session.inbox.delivered', { sessionID, inboxID: info.id }, info.time.created);
        return;
      }
      if (!messages.has(info.id)) {
        messages.set(info.id, { sessionID, parts: new Map() });
        emit(directory, 'session.step.started', { sessionID, assistantMessageID: info.id, agent: 'build', model: { providerID: PROVIDER_ID, id: modelId }, started: info.time.created }, info.time.created);
      }
      if (info.time.completed) {
        if (info.time.stopReason === 'cancelled') interrupted.add(sessionID);
        const message = messages.get(info.id);
        for (const part of p.parts || []) {
          const previous = message.parts.get(part.id);
          if (part.type === 'text' || part.type === 'reasoning') emit(directory, `session.${part.type}.ended`, { sessionID, assistantMessageID: info.id, ordinal: previous?.ordinal ?? 0, text: part.text });
        }
        const step = { sessionID, assistantMessageID: info.id };
        if (info.error) emit(directory, 'session.step.failed', { ...step, error: failure(info.error) }, info.time.completed);
        else emit(directory, 'session.step.ended', { ...step, finish: 'stop', cost: 0, tokens: ZERO_TOKENS }, info.time.completed);
      }
    } else if (payload.type === 'message.part.updated') {
      const part = p.part;
      const message = messages.get(part.messageID);
      if (!message) return;
      const previous = message.parts.get(part.id);
      const ordinal = previous?.ordinal ?? [...message.parts.values()].filter((entry) => entry.type === part.type).length;
      const data = { sessionID, assistantMessageID: part.messageID, ordinal };
      if (part.type === 'text' || part.type === 'reasoning') {
        if (!previous) emit(directory, `session.${part.type}.started`, data);
        const old = previous?.text || '';
        if (part.text.startsWith(old)) emit(directory, `session.${part.type}.delta`, { ...data, delta: part.text.slice(old.length) });
        else emit(directory, `session.${part.type}.ended`, { ...data, text: part.text });
      } else if (part.type === 'tool') {
        const tool = { sessionID, assistantMessageID: part.messageID, id: part.callID };
        if (!previous) {
          emit(directory, 'session.tool.input.started', { ...tool, name: part.tool });
          emit(directory, 'session.tool.called', { ...tool, input: isRecord(part.state.input) ? part.state.input : {}, executed: true });
        }
        if (part.state.status === 'completed') emit(directory, 'session.tool.success', { ...tool, content: [{ type: 'text', text: textOutput(part.state.output) }], executed: true });
        if (part.state.status === 'error') emit(directory, 'session.tool.failed', { ...tool, error: failure(part.state.error), executed: true });
      }
      message.parts.set(part.id, { ordinal, type: part.type, text: part.text });
    }
  };
}

export function decorateDeepSeekSession(info) {
  const modelId = info?.metadata?.openchamberDeepSeekModel;
  return info?.metadata?.openchamberBackend === 'deepseek' && asNonEmptyString(modelId)
    ? { ...info, model: { providerID: PROVIDER_ID, id: modelId } }
    : info;
}
