import { z } from 'zod';

export const hostEventSchema = z.object({ type: z.string(), seq: z.number().int(), time: z.number(), data: z.unknown() });
const dataSchema = z.record(z.string(), z.unknown());
const blockSchema = z.object({ type: z.string(), text: z.string().optional(), id: z.string().optional(), name: z.string().optional(), arguments: z.string().optional() });
const contentSchema = z.array(blockSchema);
const safeInput = (text) => { try { return JSON.parse(text || '{}'); } catch { return {}; } };
export const hostSessionID = (id) => id.startsWith('ses_') ? id : `ses_dsh_host_${Buffer.from(id).toString('base64url')}`;
export const fromHostSessionID = (id) => id.startsWith('ses_dsh_host_') ? Buffer.from(id.slice(13), 'base64url').toString() : null;

export function createHostTranscript({ sessionID, directory, publish = () => {} }) {
  const records = new Map();
  const seen = new Set();
  let attempt;
  const emit = (type, properties, live) => { if (live) publish({ directory, payload: { type, properties } }); };
  const stepID = (turn, step) => `msg_dsh_${Buffer.from(sessionID).toString('base64url')}_${turn}_${step}`;
  function assistant(data, time, live) {
    const id = stepID(data.turn, data.step);
    let record = records.get(id);
    if (!record) {
      record = { info: { id, sessionID, role: 'assistant', time: { created: time } }, parts: [] };
      records.set(id, record);
    }
    emit('message.updated', { info: record.info }, live);
    return record;
  }
  function setParts(record, content, time, live) {
    emit('message.updated', { info: record.info }, live);
    const previousParts = record.parts;
    const parts = [];
    for (const [index, block] of content.entries()) {
      const id = `${record.info.id}_${index}`;
      if (block.type === 'text' || block.type === 'reasoning' || block.type === 'thinking') {
        parts.push({ id, messageID: record.info.id, sessionID, type: block.type === 'text' ? 'text' : 'reasoning', text: block.text || '' });
      } else if (block.type === 'tool-call' && block.id && block.name) {
        const previous = record.parts.find((part) => part.type === 'tool' && part.callID === block.id);
        parts.push(previous || { id, messageID: record.info.id, sessionID, type: 'tool', callID: block.id, tool: block.name,
          state: { status: 'running', input: safeInput(block.arguments), time: { start: time } } });
      }
    }
    record.parts = parts;
    for (const part of parts) {
      if (JSON.stringify(previousParts.find((previous) => previous.id === part.id)) !== JSON.stringify(part)) emit('message.part.updated', { part }, live);
    }
  }
  function accept(raw, live = false) {
    const event = hostEventSchema.parse(raw);
    if (seen.has(event.seq)) return;
    seen.add(event.seq);
    const data = dataSchema.parse(event.data);
    if (event.type === 'user/message' && data.source?.kind === 'user') {
      const id = z.string().startsWith('msg_').safeParse(data.source?.rpcId).data || `msg_dsh_${Buffer.from(sessionID).toString('base64url')}_u${event.seq}`;
      const parts = contentSchema.parse(data.content).filter((b) => b.type === 'text').map((b, i) => ({ id: `${id}_${i}`, messageID: id, sessionID, type: 'text', text: b.text || '' }));
      const info = { id, sessionID, role: 'user', time: { created: event.time } };
      records.set(id, { info, parts });
      emit('message.updated', { info, parts }, live);
    } else if (event.type === 'assistant/message') {
      const message = dataSchema.parse(data.message);
      const record = assistant(data, event.time, live);
      setParts(record, contentSchema.parse(message.content), event.time, live);
    } else if (event.type === 'tool/call') {
      const record = assistant(data, event.time, live);
      if (!record.parts.some((part) => part.callID === data.callId)) {
        const part = { id: `${record.info.id}_tool_${data.callId}`, messageID: record.info.id, sessionID, type: 'tool', callID: data.callId, tool: data.name,
          state: { status: 'running', input: safeInput(data.arguments), time: { start: event.time } } };
        record.parts.push(part);
        emit('message.part.updated', { part }, live);
      }
    } else if (event.type === 'tool/result') {
      const message = dataSchema.parse(data.message);
      const record = assistant(data, event.time, live);
      const part = record.parts.find((p) => p.type === 'tool' && p.callID === message.toolCallId);
      if (part) {
        const output = contentSchema.parse(message.content).map((b) => b.text || '').join('\n');
        part.state = { ...part.state, status: message.isError ? 'error' : 'completed', output, error: message.isError ? output : undefined, time: { ...part.state.time, end: event.time } };
        emit('message.part.updated', { part }, live);
      }

    } else if (event.type === 'step/end') {
      const record = assistant(data, event.time, live);
      record.info.time.completed = event.time;
      emit('message.updated', { info: record.info, parts: record.parts }, live);
    }
  }
  function frame(frame, live = true) {
    if (frame.type === 'start') {
      attempt = { ...frame, content: [], record: assistant(frame, Date.now(), live), nextIndex: 0 };
    } else if (frame.type === 'chunk') {
      if (!attempt || attempt.attemptId !== frame.attemptId || frame.index !== attempt.nextIndex) throw new Error('DeepSeek assistant stream lost continuity');
      attempt.nextIndex++;
      const packed = dataSchema.parse(frame.chunk);
      const chunk = packed.type === 'chunk' ? dataSchema.parse(packed.chunk) : packed;
      const index = chunk.index;
      if (packed.type === 'text-chunks' || packed.type === 'reasoning-chunks') {
        const block = attempt.content[index] ||= { type: packed.type === 'text-chunks' ? 'text' : 'reasoning', text: '' };
        block.text += z.array(z.string()).parse(packed.texts).join('');
      } else if (chunk.type === 'block-start') {
        attempt.content[index] = { type: chunk.blockType, text: '' };
      } else if (chunk.type === 'block-end') {
        attempt.content[index] = blockSchema.parse(chunk.block);
      } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        const block = attempt.content[index] ||= { type: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: '' };
        block.text += z.string().parse(chunk.text);
      }
      setParts(attempt.record, attempt.content.filter(Boolean), frame.time, live);
    } else if (frame.type === 'end') {
      attempt = undefined;
    }
  }
  function baseline(active) {
    if (!active) return;
    frame({ ...active, type: 'start' }, false);
    for (const [index, chunk] of active.stream.entries()) frame({ type: 'chunk', attemptId: active.attemptId, index, chunk, time: Date.now() }, false);
    // Baseline stream entries are packed; nextIndex counts the Host's live frames.
    attempt.nextIndex = active.nextIndex;
  }
  return { accept, frame, baseline, records: () => [...records.values()] };
}
