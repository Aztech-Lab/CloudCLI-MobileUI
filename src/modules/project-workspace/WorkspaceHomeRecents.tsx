import { ChevronRight, Folder } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { api } from '@/shared/api';
import type { RecentConversationListItem } from '@/shared/types';
import { LLMProviderLogo } from '@/shared/ui';
import {
  formatRecentAge,
  HOME_RECENT_FETCH_LIMIT,
  HOME_RECENT_SESSION_LIMIT,
  openRecentConversation,
  pickRecentProjects,
} from '@/modules/project-workspace/utils/homeRecents';

/**
 * [local] Home screen "pick up where you left off": the most recent conversations
 * across all projects and the projects they belong to, one tap away. Kept small on
 * purpose: it reads the same feed as the sidebar's Conversations tab and opens items
 * through the same project/session handlers the sidebar uses.
 */

type RecentConversationsPayload = {
  data?: { conversations?: RecentConversationListItem[] };
};

type WorkspaceHomeRecentsProps = {
  /** Shown instead when there is nothing recent (first run) or the feed fails. */
  fallback: ReactNode;
};

type LoadState = 'loading' | 'ready' | 'empty';

/** Rendered by WorkspaceStateView on the home screen (no project selected). */
export default function WorkspaceHomeRecents({ fallback }: WorkspaceHomeRecentsProps) {
  const { t, i18n } = useTranslation();
  const { sidebarSharedProps } = useProjectSidebarState();
  const { projects, onProjectSelect, onSessionSelect } = sidebarSharedProps;
  const [conversations, setConversations] = useState<RecentConversationListItem[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  // Ages are shown relative to when the list arrived; the home screen is short-lived.
  const [loadedAt, setLoadedAt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await api.recentConversations({ limit: HOME_RECENT_FETCH_LIMIT, offset: 0 });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as RecentConversationsPayload;
        const items = payload.data?.conversations ?? [];
        if (cancelled) return;
        setLoadedAt(Date.now());
        setConversations(items);
        setLoadState(items.length > 0 ? 'ready' : 'empty');
      } catch (error) {
        if (cancelled) return;
        console.warn('[Home] Could not load recent conversations:', error);
        setLoadState('empty');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const recentProjects = useMemo(
    () => pickRecentProjects(conversations, projects),
    [conversations, projects],
  );

  // A blank moment while the first page loads beats flashing the intro and then
  // replacing it.
  if (loadState === 'loading') return null;
  if (loadState === 'empty') return <>{fallback}</>;

  const sessions = conversations.slice(0, HOME_RECENT_SESSION_LIMIT);

  return (
    <div className="w-full">
      <h2 className="mb-3 text-base font-semibold text-foreground">
        {t('mainContent.pickUpTitle', { defaultValue: 'Pick up where you left off' })}
      </h2>

      <ul className="space-y-1.5" aria-label={t('mainContent.recentSessions', { defaultValue: 'Recent conversations' })}>
        {sessions.map((conversation) => (
          <li key={conversation.sessionId}>
            <button
              type="button"
              onClick={() => openRecentConversation(conversation, { projects, onProjectSelect, onSessionSelect })}
              className="flex w-full items-center gap-3 rounded-xl border border-border/50 bg-card/60 px-3 py-2.5 text-left transition-colors hover:bg-accent/60 active:bg-accent"
            >
              <LLMProviderLogo provider={conversation.provider} className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {conversation.sessionTitle || t('mainContent.untitledSession')}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[conversation.projectDisplayName, formatRecentAge(conversation.lastActivity, loadedAt, i18n.language)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
            </button>
          </li>
        ))}
      </ul>

      {recentProjects.length > 0 && (
        <>
          <h3 className="mb-2 mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('mainContent.recentProjects', { defaultValue: 'Recent projects' })}
          </h3>
          <div className="flex flex-wrap gap-2">
            {recentProjects.map((project) => (
              <button
                key={project.projectId}
                type="button"
                onClick={() => onProjectSelect(project)}
                className="flex max-w-full items-center gap-1.5 rounded-lg border border-border/50 bg-card/60 px-2.5 py-1.5 text-sm text-foreground transition-colors hover:bg-accent/60 active:bg-accent"
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{project.displayName}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
