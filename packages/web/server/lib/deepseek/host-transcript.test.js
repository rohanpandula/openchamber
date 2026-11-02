import { describe, expect, it } from 'vitest';
import { createHostTranscript, hostSessionID, fromHostSessionID } from './host-transcript.js';

describe('shared Harness history', () => {
  it('keeps existing client IDs and deterministically maps Harness IDs', () => {
    expect(hostSessionID('ses_client')).toBe('ses_client');
    expect(fromHostSessionID(hostSessionID('session-abcd'))).toBe('session-abcd');
  });
  it('joins tool results to their parent step and ignores injected internal prompts', () => {
    const events = [];
    const transcript = createHostTranscript({ sessionID: 'ses_test', directory: '/tmp', publish: (event) => events.push(structuredClone(event)) });
    const accept = (seq, type, data) => transcript.accept({ seq, type, data, time: 1000 + seq }, true);
    accept(1, 'user/message', { source: { kind: 'user', rpcId: 'msg_client' }, content: [{ type: 'text', text: 'Hello' }] });
    accept(2, 'user/message', { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'internal' }] });
    accept(3, 'step/start', { turn: 1, step: 1 });
    accept(4, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Working' }, { type: 'tool-call', id: 'child1', name: 'subagent', arguments: '{"task":"check"}' }] } });
    accept(5, 'tool/result', { turn: 1, step: 1, message: { toolCallId: 'child1', content: [{ type: 'text', text: 'Done' }] } });
    accept(6, 'step/end', { turn: 1, step: 1 });
    accept(6, 'step/end', { turn: 1, step: 1 });
    const records = transcript.records();
    expect(records).toHaveLength(2);
    expect(records[0].info.id).toBe('msg_client');
    expect(records[1].parts[1]).toMatchObject({ tool: 'subagent', state: { status: 'completed', output: 'Done' } });
    expect(events.filter((e) => e.payload.type === 'message.updated' && e.payload.properties.info.time.completed)).toHaveLength(1);
    expect(records[1].info.time.completed).toBe(1006);
    expect(records[0].info.time.created).toBeLessThan(records[1].info.time.created);
  });
  it('reconstructs a live packed text baseline and applies the next host frame', () => {
    const transcript = createHostTranscript({ sessionID: 'ses_test', directory: '/tmp' });
    transcript.baseline({ attemptId: 'a', turn: 1, step: 1, nextIndex: 8, stream: [
      { type: 'chunk', chunk: { type: 'block-start', blockType: 'text', index: 0 } },
      { type: 'text-chunks', index: 0, texts: ['Hello', ' there'] },
    ] });
    transcript.frame({ type: 'chunk', attemptId: 'a', index: 8, time: 1, chunk: { type: 'text-chunks', index: 0, texts: ['!'] } });
    expect(transcript.records()[0].parts[0].text).toBe('Hello there!');
    expect(() => transcript.frame({ type: 'chunk', attemptId: 'a', index: 10, chunk: {} })).toThrow('continuity');
  });
});
