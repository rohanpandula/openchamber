import { describe, expect, it, vi } from 'vitest';
import { createHostQuestions } from './host-questions.js';
const setup = () => {
  const events = [], respond = vi.fn(async () => {}), call = vi.fn(async () => true);
  const questions = createHostQuestions({ nativeID: (id) => id, getSession: (id) => id === 'ses_test' ? { directory: '/repo' } : null, publish: (event) => events.push(event), call });
  const event = { event: 'user-questions/request', eventId: 'one', agentId: 'ses_test', request: { questions: [{ id: 'color', question: 'Which color?', options: [{ label: 'Blue' }, { label: 'Green' }] }] } };
  return { questions, events, respond, event, call };
};
describe('Harness questions', () => {
  it('shows choices and sends only the user-selected answer to the owning request', async () => {
    const { questions, events, respond, event } = setup();
    expect(questions.handle(event, respond)).toBe(true);
    expect(respond).not.toHaveBeenCalled();
    const [form] = questions.list('/repo');
    expect(form.fields[0].options.map((o) => o.value)).toEqual(['Blue', 'Green']);
    await expect(questions.answer('ses_other', form.id, { color: 'Blue' })).rejects.toThrow('no longer pending');
    await questions.answer('ses_test', form.id, { color: 'Green' });
    expect(respond).toHaveBeenCalledWith({ kind: 'result', value: { answers: [{ id: 'color', selected: ['Green'] }] } });
    expect(questions.list()).toEqual([]);
    expect(events.at(-1).payload.type).toBe('form.replied');
  });
  it('leaves unrelated requests alone and removes a cancelled request', () => {
    const { questions, respond, event } = setup();
    expect(questions.handle({ ...event, agentId: 'other' }, respond)).toBe(false);
    questions.handle(event, respond);questions.cancel('one');
    expect(questions.list()).toEqual([]);expect(respond).not.toHaveBeenCalled();
  });
  it('retains the question when answering fails and supports custom text', async () => {
    const { questions, respond, event } = setup();respond.mockRejectedValueOnce(new Error('offline'));
    questions.handle(event, respond);const [form] = questions.list();
    await expect(questions.answer('ses_test', form.id, { color: 'Purple' })).rejects.toThrow('offline');
    expect(questions.list()).toHaveLength(1);await questions.answer('ses_test', form.id, { color: 'Purple' });
    expect(respond).toHaveBeenLastCalledWith({ kind: 'result', value: { answers: [{ id: 'color', selected: [], custom: 'Purple' }] } });
  });
  it('answers a continued timed question using the gateway wire arguments', async () => {
    const { questions, call, event } = setup();
    const session = { id: 'ses_test', hostID: 'host_test' };
    questions.sync(session, { active: [{ callId: 'timed', state: 'continued', questions: event.request.questions }] });
    const [form] = questions.list();
    await questions.answer(session.id, form.id, { color: 'Blue' });
    expect(call).toHaveBeenCalledWith('userQuestions/answer', { agentId: 'host_test', callId: 'timed', answer: { answers: [{ id: 'color', selected: ['Blue'] }] } });
    expect(questions.list()).toEqual([]);
    questions.sync(session, { active: [{ callId: 'timed', state: 'continued', questions: event.request.questions }] });
    expect(questions.list()).toEqual([]);
  });
  it('replays pending questions after reconnect without submitting an answer', () => {
    const { questions, respond, event, events } = setup();
    questions.handle(event, respond);
    const id = questions.list()[0].id;
    questions.clear();
    questions.handle(event, respond);
    expect(questions.list()[0].id).toBe(id);
    expect(respond).not.toHaveBeenCalled();
    expect(events.map((e) => e.payload.type)).toEqual(['form.created', 'form.cancelled', 'form.created']);
  });

});
