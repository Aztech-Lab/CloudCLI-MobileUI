import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage, Project, ProjectSession } from '@/shared/types';

/**
 * [local] A message sent to join a session's running process can be refused
 * before it becomes a turn; its optimistic row then has to go. The composer
 * names that row up front (`optimisticId`), the session state stores the echo
 * under that id, and the store withdraws one live row by id. Such a row still
 * starts with `local_`, so a row the server did take is reconciled with the
 * persisted copy like any other optimistic echo.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
      sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }),
    },
  },
}));

const live = (id: string, content: string, timestamp = new Date().toISOString()): NormalizedMessage => ({
  id,
  kind: 'text',
  role: 'user',
  provider: 'claude',
  sessionId: 'session-1',
  content,
  timestamp,
} as NormalizedMessage);

beforeEach(() => {
  sessionMessages.mockReset();
  sessionMessages.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { messages: [], total: 0, hasMore: false } }),
  });
});

afterEach(() => {
  vi.resetModules();
});

describe('removeRealtime', () => {
  it('withdraws exactly the named live row', async () => {
    const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.appendRealtime('session-1', live('local_1', 'kept'));
      result.current.appendRealtime('session-1', live('local_adopt_abc', 'refused'));
    });
    act(() => {
      result.current.removeRealtime('session-1', 'local_adopt_abc');
    });

    assert.deepEqual(result.current.getMessages('session-1').map((message) => message.content), ['kept']);
  });

  it('leaves the store as it is for an id it does not hold', async () => {
    const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.appendRealtime('session-1', live('local_1', 'kept'));
    });
    const before = result.current.getMessages('session-1');
    act(() => {
      result.current.removeRealtime('session-1', 'local_adopt_missing');
      result.current.removeRealtime('other-session', 'local_1');
    });

    assert.equal(result.current.getMessages('session-1'), before, 'nothing recomputed');
  });

  it('a named optimistic row is still replaced by its persisted copy', async () => {
    const sentAt = new Date();
    sessionMessages.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          messages: [live('persisted-uuid', 'joined the running process', new Date(sentAt.getTime() + 1000).toISOString())],
          total: 1,
          hasMore: false,
        },
      }),
    });
    const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.appendRealtime('session-1', live('local_adopt_abc', 'joined the running process', sentAt.toISOString()));
    });
    await act(async () => {
      await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
    });

    assert.deepEqual(result.current.getMessages('session-1').map((message) => message.id), ['persisted-uuid']);
  });
});

describe('addMessage', () => {
  const project: Project = { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false };
  const session: ProjectSession = { id: 'session-1', summary: 'A', lastActivity: '2026-01-01T00:00:00.000Z', messageCount: 1 } as ProjectSession;
  const slot = { fetchedAt: 1, status: 'idle' as const, total: 0, hasMore: false, offset: 0 };

  const renderSessionState = async () => {
    const appended: NormalizedMessage[] = [];
    const store = {
      fetchFromServer: vi.fn(async () => slot),
      fetchMore: vi.fn(),
      appendRealtime: vi.fn((_sessionId: string, message: NormalizedMessage) => { appended.push(message); }),
      refreshLatestFromServer: vi.fn(),
      setActiveSession: vi.fn(),
      isStale: vi.fn(() => false),
      updateStreaming: vi.fn(),
      finalizeStreaming: vi.fn(),
      getMessages: vi.fn(() => []),
      getSessionSlot: vi.fn(() => slot),
    };
    const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
    const hook = renderHook(() => useChatSessionState({
      isActive: true,
      selectedProject: project,
      selectedSession: session,
      ws: null,
      sendMessage: vi.fn(),
      resetStreamingState: vi.fn(),
      statusCheckSentAtRef: { current: new Map() },
      lastSeqRef: { current: new Map() },
      sessionStore: store as never,
    }));
    return { hook, appended };
  };

  it('stores the echo under the id the composer named', async () => {
    const { hook, appended } = await renderSessionState();

    act(() => {
      hook.result.current.addMessage({ type: 'user', content: 'hello', timestamp: new Date(), optimisticId: 'local_adopt_abc' });
    });

    assert.equal(appended.length, 1);
    assert.equal(appended[0].id, 'local_adopt_abc');
  });

  it('gives any other echo a fresh local id, as before', async () => {
    const { hook, appended } = await renderSessionState();

    act(() => {
      hook.result.current.addMessage({ type: 'user', content: 'hello', timestamp: new Date() });
    });

    assert.match(appended[0].id, /^local_\d+_[a-z0-9]+$/);
  });
});
