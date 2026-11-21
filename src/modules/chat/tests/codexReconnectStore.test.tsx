import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * [local] Stage 5 of the Codex parity plan: a page that reloads while a Codex
 * subagent runs reads the rollout's card from the history and is replayed the
 * live card, which the app-server runtime named by another id. The session
 * store keeps one card, with the live status folded onto the history card.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

const base = { sessionId: 'session-1', provider: 'codex' as const };

const HISTORY: NormalizedMessage[] = [
  { ...base, id: 'u1', timestamp: '2026-11-20T10:00:00.000Z', kind: 'text', role: 'user', content: 'survey B' },
  {
    ...base,
    id: 'hist-task',
    timestamp: '2026-11-20T10:00:01.000Z',
    kind: 'tool_use',
    toolName: 'Task',
    toolInput: JSON.stringify({ description: 'Survey B' }),
    toolId: 'call_spawn',
    subagent: { id: 'child-1', description: 'Survey B', status: 'running' },
  },
];

const liveCard: NormalizedMessage = {
  ...base,
  id: 'item-spawn',
  timestamp: '2026-11-20T10:00:02.000Z',
  kind: 'tool_use',
  toolName: 'Task',
  toolInput: { description: 'Survey B' },
  toolId: 'item-spawn',
  dedupeKey: 'agent:child-1',
  subagent: { id: 'child-1', description: 'Survey B', status: 'running' },
};

const liveStatus: NormalizedMessage = {
  ...base,
  id: 'bgagent_item-spawn_started_running',
  timestamp: '2026-11-20T10:00:05.000Z',
  kind: 'task_status',
  event: 'started',
  status: 'running',
  toolUseId: 'item-spawn',
  taskType: 'local_agent',
};

beforeEach(() => {
  sessionMessages.mockReset();
  sessionMessages.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { messages: HISTORY, total: HISTORY.length, hasMore: false } }),
  });
});

afterEach(() => {
  vi.resetModules();
});

describe('a reload while a Codex subagent runs', () => {
  it('keeps the history card and folds the replayed live status onto it', async () => {
    const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
    const { result } = renderHook(() => useSessionStore());
    await act(async () => {
      await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
    });

    act(() => {
      result.current.appendRealtime('session-1', liveCard);
      result.current.appendRealtime('session-1', liveStatus);
    });

    const messages = result.current.getMessages('session-1');
    const cards = messages.filter((message) => message.kind === 'tool_use' && message.toolName === 'Task');
    assert.deepEqual(cards.map((message) => message.toolId), ['call_spawn']);
    const status = messages.find((message) => message.kind === 'task_status');
    assert.equal(status?.toolUseId, 'call_spawn');
  });
});
