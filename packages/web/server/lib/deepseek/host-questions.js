import { z } from 'zod';

const questionSchema = z.object({
  id: z.string().min(1), question: z.string(), header: z.string().optional(), detail: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
  multiSelect: z.boolean().optional(),
});
const questionListSchema = z.array(questionSchema).min(1).refine((questions) => new Set(questions.map((q) => q.id)).size === questions.length, 'Question IDs must be unique');
const requestSchema = z.object({ questions: questionListSchema, wait: z.object({ callId: z.string(), timed: z.boolean().optional() }).optional() });
const projectionSchema = z.object({ active: z.array(z.object({ callId: z.string(), questions: questionListSchema, state: z.enum(['open', 'continued']) })) });
const answerSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));

export function createHostQuestions({ nativeID, getSession, publish, call }) {
  const pending = new Map();
  const answered = new Map();
  const formID = (sessionID, key) => `form_dsh_${Buffer.from(`${sessionID}\0${key}`).toString('base64url')}`;
  const emit = (entry, type) => publish({ directory: getSession(entry.sessionID)?.directory || 'global', payload: { type, properties: type === 'form.created' ? { form: entry.form } : { sessionID: entry.sessionID, formID: entry.form.id } } });
  function put(sessionID, key, questions, respond, eventId) {
    const id = formID(sessionID, key);
    const entry = { sessionID, eventId, questions, respond, settling: false, form: {
      id, sessionID, title: questions[0].header || 'DeepSeek Harness',
      fields: questions.map((q) => ({ key: q.id, title: q.question, description: q.detail,
        type: q.multiSelect ? 'multiselect' : 'string', custom: true,
        options: q.options || q.multiSelect ? (q.options || []).map((o) => ({ value: o.label, label: o.label, description: o.description })) : undefined,
      })),
    } };
    const previous = pending.get(id);
    pending.set(id, entry);
    if (!previous || JSON.stringify(previous.form) !== JSON.stringify(entry.form)) emit(entry, 'form.created');
  }
  function remove(id) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    emit(entry, 'form.cancelled');
  }
  return {
    handle(event, respond) {
      if (event.event !== 'user-questions/request' || !getSession(nativeID(event.agentId))) return false;
      const parsed = requestSchema.safeParse(event.request);
      if (!parsed.success) return false;
      put(nativeID(event.agentId), parsed.data.wait?.callId || event.eventId, parsed.data.questions, respond, event.eventId);
      return true;
    },
    cancel(eventId) { for (const [id, entry] of pending) if (entry.eventId === eventId) remove(id); },
    sync(session, raw) {
      const parsed = projectionSchema.safeParse(raw);
      if (!parsed.success) return;
      const active = new Set(parsed.data.active.map((q) => formID(session.id, q.callId)));
      for (const [id, owner] of answered) if (owner === session.id && !active.has(id)) answered.delete(id);
      for (const [id, entry] of pending) if (entry.sessionID === session.id && !entry.eventId && !active.has(id)) remove(id);
      for (const q of parsed.data.active) {
        const id = formID(session.id, q.callId);
        if (q.state !== 'continued' || pending.get(id)?.eventId || answered.has(id)) continue;
        put(session.id, q.callId, q.questions, async (outcome) => {
          const accepted = await call('userQuestions/answer', { agentId: session.hostID, callId: q.callId, answer: outcome.value });
          if (!accepted) throw new Error('This Harness question has already been answered.');
        });
      }
    },
    list(directory) { return [...pending.values()].filter((entry) => !directory || getSession(entry.sessionID)?.directory === directory).map((entry) => entry.form); },
    async answer(sessionID, id, raw, cancel = false) {
      const entry = pending.get(id);
      if (!entry || entry.sessionID !== sessionID) throw Object.assign(new Error('Question is no longer pending.'), { code: 'FORM_NOT_FOUND' });
      if (entry.settling) throw Object.assign(new Error('An answer is already being submitted.'), { code: 'SESSION_BUSY' });
      const values = answerSchema.parse(raw);
      if (Object.keys(values).some((key) => !entry.questions.some((q) => q.id === key))) throw new Error('Answer contains an unknown question.');
      const answers = entry.questions.map((q) => {
        const rawValue = cancel ? [] : values[q.id] ?? [];
        const selected = Array.isArray(rawValue) ? rawValue : rawValue ? [rawValue] : [];
        if (!q.multiSelect && selected.length > 1) throw new Error('Choose one answer for this question.');
        const labels = new Set((q.options || []).map((o) => o.label));
        const custom = selected.filter((value) => !labels.has(value)).join('\n');
        return { id: q.id, selected: selected.filter((value) => labels.has(value)), custom: custom || undefined };
      });
      entry.settling = true;
      try {
        await entry.respond({ kind: 'result', value: { answers } });
        pending.delete(id);
        if (!entry.eventId) answered.set(id, sessionID);
        emit(entry, cancel ? 'form.cancelled' : 'form.replied');
      } catch (error) { entry.settling = false; throw error; }
    },
    clear() { for (const id of pending.keys()) remove(id); },
  };
}
