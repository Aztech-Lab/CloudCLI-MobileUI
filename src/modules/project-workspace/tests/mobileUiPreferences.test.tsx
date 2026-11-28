import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * [local] The phone and navigation switches of Settings > MobileUI: the swipe gesture and
 * the home screen's recent list. Both default to on, which is what the app did before.
 */

const swipeNavigation = vi.hoisted(() => vi.fn());
const recentConversations = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/shared/api', () => ({
  api: {
    recentConversations,
    user: { savePreferences: () => Promise.resolve({ ok: true }) },
  },
}));

vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectSidebarState: () => ({ sidebarSharedProps: { projects: [], onProjectSelect: vi.fn(), onSessionSelect: vi.fn() } }),
}));

// WorkspaceMain's neighbours, reduced to what its loading state touches.
vi.mock('@/modules/project-workspace/hooks/useWorkspaceSwipeNavigation', () => ({ useWorkspaceSwipeNavigation: swipeNavigation }));
vi.mock('@/modules/project-workspace/hooks/useWorkspaceTabs', () => ({ useWorkspaceTabs: () => ({ tabs: [] }) }));
vi.mock('@/modules/project-workspace/hooks/useFileOpenResolver', () => ({ useFileOpenResolver: () => vi.fn() }));
vi.mock('@/modules/chat', () => ({ ChatInterface: () => null }));
vi.mock('@/modules/file-tree', () => ({ FileTree: () => null }));
vi.mock('@/modules/standalone-shell', () => ({ StandaloneShell: () => null }));
vi.mock('@/modules/git-panel', () => ({ GitPanel: () => null }));
vi.mock('@/modules/plugins', () => ({ PluginTabContent: () => null }));
vi.mock('@/modules/browser-use', () => ({ BrowserUsePanel: () => null, useBrowserUseEnabled: () => false }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => undefined }));
vi.mock('@/modules/task-master', () => ({
  TaskMasterPanel: () => null,
  useTaskMasterProjectSync: () => undefined,
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }),
}));
vi.mock('@/modules/code-editor', () => ({ EditorSidebar: () => null, useEditorSidebar: () => ({ handleFileOpen: vi.fn() }) }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({ useUiPreferences: () => ({}) }));

const { default: WorkspaceMain } = await import('@/modules/project-workspace/WorkspaceMain');
const { default: WorkspaceStateView } = await import('@/modules/project-workspace/WorkspaceStateView');
const { readMobileUiPreferences, writeMobileUiPreference } = await import('@/shared/mobileUiPreferences');
const { readUserPreference, resetUserPreferences } = await import('@/shared/userSettings');

const renderWorkspaceMain = (isMobile: boolean) => render(
  <WorkspaceMain
    {...({
      selectedProject: null,
      selectedSession: null,
      activeTab: 'chat',
      setActiveTab: vi.fn(),
      ws: null,
      sendMessage: vi.fn(),
      isMobile,
      onMenuClick: vi.fn(),
      isLoading: true,
    } as unknown as Parameters<typeof WorkspaceMain>[0])}
  />,
);

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  recentConversations.mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: { conversations: [] } }) });
});

afterEach(() => {
  swipeNavigation.mockReset();
  recentConversations.mockReset();
});

describe('mobileUi preferences', () => {
  it('default to the behaviour before the switches existed, plus the one-row phone composer', () => {
    expect(readMobileUiPreferences()).toEqual({ swipeNavigation: true, homeRecents: true, compactComposer: true });
  });

  it('are stored as one user preference and ignore values that are not booleans', () => {
    writeMobileUiPreference('swipeNavigation', false);
    expect(readUserPreference('mobileUi', null)).toEqual({ swipeNavigation: false });
    expect(readMobileUiPreferences()).toEqual({ swipeNavigation: false, homeRecents: true, compactComposer: true });
  });
});

describe('swipe navigation switch', () => {
  it('enables the gesture on phones by default', () => {
    renderWorkspaceMain(true);
    expect(swipeNavigation).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('turns the gesture off when switched off, also when the change arrives later', () => {
    renderWorkspaceMain(true);
    act(() => writeMobileUiPreference('swipeNavigation', false));
    expect(swipeNavigation).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('never enables it on a desktop', () => {
    renderWorkspaceMain(false);
    expect(swipeNavigation).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });
});

describe('home screen recents switch', () => {
  it('loads the recent list by default', async () => {
    render(<WorkspaceStateView mode="empty" isMobile={false} onMenuClick={vi.fn()} />);
    await waitFor(() => expect(recentConversations).toHaveBeenCalled());
  });

  it('shows the original intro without loading recents when switched off', () => {
    writeMobileUiPreference('homeRecents', false);
    render(<WorkspaceStateView mode="empty" isMobile={false} onMenuClick={vi.fn()} />);
    expect(screen.getByText('mainContent.chooseProject')).toBeTruthy();
    expect(recentConversations).not.toHaveBeenCalled();
  });
});
