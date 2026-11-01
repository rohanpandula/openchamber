import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { Model } from '@opencode/schema/model';
import { Provider } from '@opencode/schema/provider';
import { SessionMessage } from '@opencode/schema/session-message';
import { SessionEvent } from '@opencode/schema/session-event';
import { partsToAcpContentBlocks } from './deepseek-appserver.js';
import { createEventBridge, messageInfo, modelInfo, providerInfo, decorateDeepSeekSession } from './wire.js';

const require = createRequire(import.meta.resolve('@opencode/schema'));
const { Schema } = await import(require.resolve('effect'));
const decode = (schema, value) => Schema.decodeUnknownSync(schema)(value);

describe('DeepSeek v2 wire boundary', () => {
  it('publishes valid provider and model catalog entries', () => {
    expect(() => decode(Provider.Info, providerInfo)).not.toThrow();
    expect(() => decode(Model.Info, modelInfo('deepseek-v4-flash'))).not.toThrow();
  });
  it('projects saved messages including tools and image attachments', () => {
    const user = messageInfo({ info: { id: 'msg_user', role: 'user', time: { created: 1 } }, parts: [
      { type: 'text', text: 'hello' }, { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aGVsbG8=', filename: 'image.png' },
    ] }, 'test');
    expect(() => decode(SessionMessage.Info, user)).not.toThrow();
    const assistant = messageInfo({ info: { id: 'msg_assistant', role: 'assistant', time: { created: 2, completed: 3 } }, parts: [
      { type: 'text', text: 'hello' }, { type: 'reasoning', text: 'think' },
      { type: 'tool', tool: 'read', callID: 'call_1', state: { status: 'completed', input: {}, output: 'file' } },
    ] }, 'test');
    expect(() => decode(SessionMessage.Info, assistant)).not.toThrow();
  });
  it('streams into the same message and part identities used after reload', () => {
    const events = [];
    const bridge = createEventBridge({ publish: (event) => events.push(event.payload), modelId: 'test' });
    const send = (type, properties) => bridge({ directory: '/tmp/project', payload: { type, properties } });
    send('message.updated', { info: { id: 'msg_a', sessionID: 'ses_a', role: 'assistant', time: { created: 1 } }, parts: [] });
    send('message.part.updated', { part: { id: 'reasoning_a', messageID: 'msg_a', sessionID: 'ses_a', type: 'reasoning', text: 'thinking' } });
    send('message.part.updated', { part: { id: 'tool_a', messageID: 'msg_a', sessionID: 'ses_a', type: 'tool', tool: 'read', callID: 'call_a', state: { status: 'running', input: {} } } });
    send('message.part.updated', { part: { id: 'part_a', messageID: 'msg_a', sessionID: 'ses_a', type: 'text', text: 'hello' } });
    send('message.part.updated', { part: { id: 'part_a', messageID: 'msg_a', sessionID: 'ses_a', type: 'text', text: 'hello world' } });
    const deltas = events.filter((event) => event.type === 'session.text.delta');
    expect(deltas.map((event) => event.data.delta)).toEqual(['hello', ' world']);
    expect(deltas.every((event) => event.data.ordinal === 0)).toBe(true);
    for (const event of deltas) expect(() => decode(SessionEvent.Text.Delta, event)).not.toThrow();
    expect(events[0].data.assistantMessageID).toBe('msg_a');
  });
  it('keeps prompt timestamps stable when delivering the inbox item', () => {
    const events = [];
    const bridge = createEventBridge({ publish: (event) => events.push(event.payload), modelId: 'test' });
    bridge({ directory: '/tmp', payload: { type: 'message.updated', properties: {
      info: { id: 'msg_user', sessionID: 'ses_a', role: 'user', time: { created: 10 } }, parts: [],
    } } });
    expect(events.map((event) => event.created)).toEqual([10, 10]);
  });
  it('sends an attached image to ACP without losing its data', () => {
    expect(partsToAcpContentBlocks([{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }])).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
    ]);
  });
  it('decorates only sessions created by the DeepSeek integration', () => {
    const original = { id: 'ses_normal', metadata: { openchamberDeepSeekModel: 'test' } };
    expect(decorateDeepSeekSession(original)).toBe(original);
    expect(decorateDeepSeekSession({ ...original, metadata: { ...original.metadata, openchamberBackend: 'deepseek' } }).model).toEqual({ providerID: 'deepseek-harness', id: 'test' });
  });
});
