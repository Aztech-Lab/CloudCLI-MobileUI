import { ClipboardCheck, Folder, GitBranch, MessageSquare, MonitorPlay, Terminal, type LucideIcon } from 'lucide-react';
import { useMemo } from 'react';

import { usePlugins } from '@/modules/plugins';
import type { AppTab } from '@/shared/types';

export type BuiltInTab = {
  kind: 'builtin';
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

export type PluginTab = {
  kind: 'plugin';
  id: AppTab;
  label: string;
  pluginName: string;
  iconFile: string;
};

export type TabDefinition = BuiltInTab | PluginTab;

const CHAT_TAB: BuiltInTab = { kind: 'builtin', id: 'chat', labelKey: 'tabs.chat', icon: MessageSquare };
const FILES_TAB: BuiltInTab = { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder };
const GIT_TAB: BuiltInTab = { kind: 'builtin', id: 'git', labelKey: 'tabs.git', icon: GitBranch };
const SHELL_TAB: BuiltInTab = { kind: 'builtin', id: 'shell', labelKey: 'tabs.shell', icon: Terminal };
const BROWSER_TAB: BuiltInTab = { kind: 'builtin', id: 'browser', labelKey: 'tabs.browser', icon: MonitorPlay };
const TASKS_TAB: BuiltInTab = { kind: 'builtin', id: 'tasks', labelKey: 'tabs.tasks', icon: ClipboardCheck };

/**
 * Built-in tabs in display order. [local] The shell tab is last (upstream had it
 * second): on mobile the tabs are also reached by swiping, and the terminal sits at
 * the far end of that strip, away from chat.
 */
export function getBuiltInTabs(shouldShowTasksTab: boolean, shouldShowBrowserTab: boolean): BuiltInTab[] {
  return [
    CHAT_TAB,
    FILES_TAB,
    GIT_TAB,
    ...(shouldShowBrowserTab ? [BROWSER_TAB] : []),
    ...(shouldShowTasksTab ? [TASKS_TAB] : []),
    SHELL_TAB,
  ];
}

/**
 * The workspace tabs in display order: built-in tabs, then enabled plugin tabs.
 * Shared by the header tab strip and the mobile swipe navigation so both always
 * agree on what "next" and "previous" mean.
 */
export function useWorkspaceTabs(shouldShowTasksTab: boolean, shouldShowBrowserTab: boolean) {
  const { plugins } = usePlugins();

  return useMemo(() => {
    const builtInTabs = getBuiltInTabs(shouldShowTasksTab, shouldShowBrowserTab);
    const pluginTabs: PluginTab[] = plugins
      .filter((plugin) => plugin.enabled)
      .map((plugin) => ({
        kind: 'plugin',
        id: `plugin:${plugin.name}` as AppTab,
        label: plugin.displayName,
        pluginName: plugin.name,
        iconFile: plugin.icon,
      }));

    return { builtInTabs, pluginTabs, tabs: [...builtInTabs, ...pluginTabs] as TabDefinition[] };
  }, [plugins, shouldShowBrowserTab, shouldShowTasksTab]);
}
