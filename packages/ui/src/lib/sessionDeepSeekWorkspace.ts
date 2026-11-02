import { z } from 'zod';
import { isSessionPinned } from './sessionPins';
import type { Session } from './opencode/model';

const workspaceSchema = z.union([
  z.object({ id: z.string(), path: z.string(), title: z.string(), order: z.number().optional() }),
  z.object({ kind: z.literal('ungrouped'), order: z.number().optional() }),
]);

/** Undefined is ordinary OpenCode/legacy state; null is explicitly ungrouped in Harness. */
export function deepSeekWorkspace(session: Session) {
  if (!session.metadata?.openchamberDeepSeekWorkspace) return undefined;
  const parsed = workspaceSchema.safeParse(session.metadata.openchamberDeepSeekWorkspace);
  if (!parsed.success) return undefined;
  return 'kind' in parsed.data ? null : parsed.data;
}

function deepSeekSidebarOrder(session: Session) {
  if (!session.metadata?.openchamberDeepSeekWorkspace) return null;
  const parsed = workspaceSchema.safeParse(session.metadata?.openchamberDeepSeekWorkspace);
  if (!parsed.success || parsed.data.order === undefined) return null;
  return { scope: 'kind' in parsed.data ? 'ungrouped' : parsed.data.id, rank: parsed.data.order };
}

/** Reorder only each workspace's occupied slots; unrelated chats keep their ordering. */
export function orderDeepSeekWorkspaceSessions(sessions: Session[], pinnedSessionIds: Set<string> = new Set()): Session[] {
  const groups = new Map<string, Array<{ session: Session; rank: number }>>();
  for (const session of sessions) {
    const order = deepSeekSidebarOrder(session);
    if (!order) continue;
    const scope = `${order.scope}:${isSessionPinned(pinnedSessionIds, session.directory, session.id)}`;
    const group = groups.get(scope) || [];
    group.push({ session, rank: order.rank });
    groups.set(scope, group);
  }
  for (const group of groups.values()) group.sort((a, b) => a.rank - b.rank);
  const offsets = new Map<string, number>();
  return sessions.map((session) => {
    const order = deepSeekSidebarOrder(session);
    if (!order) return session;
    const scope = `${order.scope}:${isSessionPinned(pinnedSessionIds, session.directory, session.id)}`;
    const index = offsets.get(scope) || 0;
    offsets.set(scope, index + 1);
    return groups.get(scope)?.[index]?.session ?? session;
  });
}
