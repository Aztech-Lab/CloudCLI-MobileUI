import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sidebarState = vi.hoisted(() => ({
  projects: [] as Project[],
  onProjectSelect: vi.fn(),
  onSessionSelect: vi.fn(),
}));
const recentConversations = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectSidebarState: () => ({ sidebarSharedProps: sidebarState }),
}));

vi.mock('@/shared/api', () => ({
  api: { recentConversations },
}));

import WorkspaceHomeRecents from '@/modules/project-workspace/WorkspaceHomeRecents';
import {
  formatRecentAge,
  openRecentConversation,
  pickRecentProjects,
} from '@/modules/project-workspace/utils/homeRecents';
import type { Project, RecentConversationListItem } from '@/shared/types';

function conversation(sessionId: string, projectId: string | null, extra: Partial<RecentConversationListItem> = {}): RecentConversationListItem {
  return {
    sessionId,
    projectId,
    provider: 'claude',
    projectDisplayName: projectId ? `Project ${projectId}` : null,
    sessionTitle: `Session ${sessionId}`,
    lastActivity: new Date().toISOString(),
    ...extra,
  } as RecentConversationListItem;
}

function project(projectId: string, sessions: Project['sessions'] = []): Project {
  return { projectId, displayName: `Project ${projectId}`, fullPath: `/p/${projectId}`, sessions };
}

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
}

describe('pickRecentProjects', () => {
  it('keeps the order of first appearance, skips duplicates and unknown projects, and caps the list', () => {
    const conversations = [
      conversation('s1', 'b'),
      conversation('s2', 'a'),
      conversation('s3', 'b'),
      conversation('s4', 'gone'),
      conversation('s5', null),
      conversation('s6', 'c'),
    ];
    const projects = [project('a'), project('b'), project('c')];

    expect(pickRecentProjects(conversations, projects).map((p) => p.projectId)).toEqual(['b', 'a', 'c']);
    expect(pickRecentProjects(conversations, projects, 2).map((p) => p.projectId)).toEqual(['b', 'a']);
  });
});

describe('openRecentConversation', () => {
  it('selects the project, then its already-loaded session row', () => {
    const onProjectSelect = vi.fn();
    const onSessionSelect = vi.fn();
    const loaded = { id: 's1', summary: 'Loaded title', __provider: 'codex' as const };
    const owner = project('a', [loaded]);

    openRecentConversation(conversation('s1', 'a'), { projects: [owner], onProjectSelect, onSessionSelect });

    expect(onProjectSelect).toHaveBeenCalledWith(owner);
    expect(onSessionSelect).toHaveBeenCalledWith({ ...loaded, __projectId: 'a' });
    expect(onProjectSelect.mock.invocationCallOrder[0]).toBeLessThan(onSessionSelect.mock.invocationCallOrder[0]);
  });

  it('falls back to a minimal session when the row is not loaded', () => {
    const onProjectSelect = vi.fn();
    const onSessionSelect = vi.fn();

    openRecentConversation(conversation('s9', 'a', { provider: 'codex' }), {
      projects: [project('a')],
      onProjectSelect,
      onSessionSelect,
    });

    expect(onSessionSelect).toHaveBeenCalledWith({ id: 's9', __provider: 'codex', __projectId: 'a' });
  });

  it('still opens the session when its project is unknown', () => {
    const onProjectSelect = vi.fn();
    const onSessionSelect = vi.fn();

    openRecentConversation(conversation('s1', null), { projects: [], onProjectSelect, onSessionSelect });

    expect(onProjectSelect).not.toHaveBeenCalled();
    expect(onSessionSelect).toHaveBeenCalledWith({ id: 's1', __provider: 'claude', __projectId: undefined });
  });
});

describe('formatRecentAge', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');

  it('formats relative ages and tolerates missing or invalid input', () => {
    expect(formatRecentAge('2026-11-14T11:55:00Z', now, 'en')).toMatch(/5 min/);
    expect(formatRecentAge('2026-11-14T09:00:00Z', now, 'en')).toMatch(/3 hr/);
    expect(formatRecentAge('2026-11-12T12:00:00Z', now, 'en')).toMatch(/2 days/);
    expect(formatRecentAge(null, now, 'en')).toBe('');
    expect(formatRecentAge('not a date', now, 'en')).toBe('');
  });
});

describe('WorkspaceHomeRecents', () => {
  beforeEach(() => {
    sidebarState.projects = [project('a'), project('b')];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lists recent conversations and projects, and opens them through the sidebar handlers', async () => {
    recentConversations.mockReturnValue(okJson({
      data: { conversations: [conversation('s1', 'a'), conversation('s2', 'b'), conversation('s3', 'a')] },
    }));

    render(<WorkspaceHomeRecents fallback={<p>intro</p>} />);

    const first = await screen.findByRole('button', { name: /Session s1/ });
    expect(screen.queryByText('intro')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);

    fireEvent.click(first);
    expect(sidebarState.onProjectSelect).toHaveBeenCalledWith(sidebarState.projects[0]);
    expect(sidebarState.onSessionSelect).toHaveBeenCalledWith({ id: 's1', __provider: 'claude', __projectId: 'a' });

    // Project chips: a then b, each once.
    const chips = screen.getAllByRole('button', { name: /^Project / });
    expect(chips.map((chip) => chip.textContent)).toEqual(['Project a', 'Project b']);
    fireEvent.click(chips[1]);
    expect(sidebarState.onProjectSelect).toHaveBeenLastCalledWith(sidebarState.projects[1]);
  });

  it('shows the fallback when there is nothing recent or the feed fails', async () => {
    recentConversations.mockReturnValue(okJson({ data: { conversations: [] } }));
    const { unmount } = render(<WorkspaceHomeRecents fallback={<p>intro</p>} />);
    expect(await screen.findByText('intro')).toBeTruthy();
    unmount();

    recentConversations.mockReturnValue(Promise.reject(new Error('offline')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<WorkspaceHomeRecents fallback={<p>intro</p>} />);
    await waitFor(() => expect(screen.getByText('intro')).toBeTruthy());
  });

  it('caps the list at five conversations', async () => {
    recentConversations.mockReturnValue(okJson({
      data: { conversations: Array.from({ length: 9 }, (_, i) => conversation(`s${i}`, 'a')) },
    }));

    render(<WorkspaceHomeRecents fallback={<p>intro</p>} />);
    await screen.findByRole('button', { name: /Session s0/ });
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });
});
