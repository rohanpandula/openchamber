import { expect, test } from 'bun:test';
import { getPinnedSessionKey } from './sessionPins';
import { getRuntimeKey } from './runtime-switch';
import type { Session } from './opencode/model';
import { orderDeepSeekWorkspaceSessions } from './sessionDeepSeekWorkspace';

const entry = (id: string, order?: number): Session => ({
  id, directory: '/repo', projectID: 'project', title: id, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  metadata: order === undefined ? {} : { openchamberDeepSeekWorkspace: { id: 'w', path: '/repo', title: 'Repo', order } },
});

test('orders a workspace consistently while leaving unrelated slots alone', () => {
  const first = entry('first', 0), second = entry('second', 1), ordinary = entry('ordinary');
  expect(orderDeepSeekWorkspaceSessions([second, ordinary, first]).map(s => s.id)).toEqual(['first', 'ordinary', 'second']);
  expect(orderDeepSeekWorkspaceSessions([first, ordinary, second]).map(s => s.id)).toEqual(['first', 'ordinary', 'second']);
});

test('workspace order retains pinned chat priority', () => {
  const pinned = entry('pinned', 1), ordinary = entry('ordinary', 0);
  const key = getPinnedSessionKey(getRuntimeKey(), '/repo', 'pinned');
  if (!key) throw new Error('Expected a valid pin key');
  expect(orderDeepSeekWorkspaceSessions([pinned, ordinary], new Set([key])).map(s => s.id)).toEqual(['pinned', 'ordinary']);
});
