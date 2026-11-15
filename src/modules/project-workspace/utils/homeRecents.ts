import type { LLMProvider, Project, ProjectSession, RecentConversationListItem } from '@/shared/types';

/**
 * [local] Helpers for the home screen's recent conversations/projects
 * (WorkspaceHomeRecents), kept apart from the component for fast refresh and tests.
 */

/** How many conversations are requested and shown. */
export const HOME_RECENT_FETCH_LIMIT = 12;
export const HOME_RECENT_SESSION_LIMIT = 5;
export const HOME_RECENT_PROJECT_LIMIT = 4;

/** The distinct projects of `conversations`, most recent first, that are still in `projects`. */
export function pickRecentProjects(
  conversations: readonly RecentConversationListItem[],
  projects: readonly Project[],
  limit = HOME_RECENT_PROJECT_LIMIT,
): Project[] {
  const byId = new Map(projects.map((project) => [project.projectId, project]));
  const picked: Project[] = [];
  const seen = new Set<string>();
  for (const conversation of conversations) {
    const projectId = conversation.projectId;
    if (!projectId || seen.has(projectId)) continue;
    seen.add(projectId);
    const project = byId.get(projectId);
    if (project) picked.push(project);
    if (picked.length >= limit) break;
  }
  return picked;
}

type OpenConversationHandlers = {
  projects: readonly Project[];
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession) => void;
};

/**
 * Opens a recent conversation exactly like the sidebar's Conversations tab: select
 * its project first (when it is still known), then the session, preferring the
 * already-loaded session row so its title and provider are kept.
 */
export function openRecentConversation(
  conversation: RecentConversationListItem,
  { projects, onProjectSelect, onSessionSelect }: OpenConversationHandlers,
) {
  const provider = (conversation.provider || 'claude') as LLMProvider;
  const project = conversation.projectId
    ? projects.find((candidate) => candidate.projectId === conversation.projectId)
    : undefined;

  if (!project) {
    onSessionSelect({
      id: conversation.sessionId,
      __provider: provider,
      __projectId: conversation.projectId ?? undefined,
    });
    return;
  }

  onProjectSelect(project);
  const existing = project.sessions?.find((session) => session.id === conversation.sessionId);
  onSessionSelect({
    ...(existing ?? { id: conversation.sessionId, __provider: provider }),
    __projectId: project.projectId,
  });
}

/** "5 min ago" / "5 分钟前" for an ISO timestamp, in the UI language. */
export function formatRecentAge(iso: string | null, now: number, locale: string): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';

  const seconds = Math.round((then - now) / 1000);
  const abs = Math.abs(seconds);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (abs < 60) return format.format(0, 'second');
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return format.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86400 * 30) return format.format(Math.round(seconds / 86400), 'day');
  return new Date(then).toLocaleDateString(locale);
}
