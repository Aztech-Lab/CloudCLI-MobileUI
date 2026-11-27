import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import '@/shared/mobileUiI18n';
import { setShowIgnoredFiles, useShowIgnoredFiles } from '@/shared/showIgnoredFiles';
import MobileUiSettingsTab from '@/modules/settings/tabs/mobileui-settings/MobileUiSettingsTab';
import { SkinProvider } from '@/shared/context/SkinContext';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { readUserPreference, resetUserPreferences } from '@/shared/userSettings';
import type { ServerControlStatus } from '@/shared/types';

/**
 * [local] Settings > MobileUI: the fork's own settings tab.
 */

const STATUS: ServerControlStatus = {
  instance: 'live',
  port: 3001,
  listenAddress: '127.0.0.1',
  running: true,
  pid: 4242,
  version: '1.37.10',
  activeWork: { turns: 0, backgroundSessions: 0, backgroundTasks: 0 },
  build: null,
  pendingBuild: null,
  autostart: 'on',
  autostartName: 'CloudCLI-MobileUI',
};

let managed = false;

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

function fakeServer(url: string): Response {
  if (url === '/api/server-control') {
    return json({ success: true, data: managed ? { managed: true, instance: 'live' } : { managed: false } });
  }
  if (url === '/api/server-control/status') {
    return json({ success: true, data: managed ? { managed: true, instance: 'live', platform: 'win32', status: STATUS } : { managed: false } });
  }
  if (url === '/api/server-control/settings') {
    return json({ success: true, data: { managed, instance: managed ? 'live' : null, settings: [] } });
  }
  return new Response('{}', { status: 404 });
}

const renderTab = (initialTab?: string) => render(
  <UiPreferencesProvider>
    <SkinProvider>
      <MobileUiSettingsTab initialTab={initialTab} />
    </SkinProvider>
  </UiPreferencesProvider>,
);

beforeEach(() => {
  managed = false;
  localStorage.clear();
  resetUserPreferences();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => fakeServer(url)));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-skin');
  document.documentElement.removeAttribute('data-assistant-bubble');
});

describe('Settings > MobileUI', () => {
  it('renders its sections in order, without Server for an unmanaged server', async () => {
    renderTab();
    const headings = () => screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(headings()).toEqual(expect.arrayContaining(['Look', 'Conversation', 'Files', 'About this edition']));
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByText('Server')).toBeNull();
  });

  it('shows the Server section for a script-managed server and scrolls to it for the old server tab', async () => {
    managed = true;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderTab('server');
    expect(await screen.findByText('Running on port 3001 (PID 4242)')).toBeTruthy();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
  });

  it('chooses a skin from the cards and stores it', () => {
    renderTab();
    const card = screen.getByTestId('mobileui-skin-otsr');
    expect(card.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(card);
    expect(card.getAttribute('aria-checked')).toBe('true');
    expect(readUserPreference('skin', 'default')).toBe('otsr');
    expect(document.documentElement.getAttribute('data-skin')).toBe('otsr');
    // The OTSR options appear with it.
    expect(screen.getByRole('switch', { name: 'Chamfered edges' })).toBeTruthy();
  });

  it('stores the reply bubble style', () => {
    renderTab();
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent reply bubble' }), { target: { value: 'off' } });
    expect(readUserPreference('assistantBubble', null)).toBe('off');
    expect(document.documentElement.getAttribute('data-assistant-bubble')).toBe('off');
  });

  it('disables auto-expand thinking while thinking is hidden', () => {
    renderTab();
    const autoExpand = screen.getByRole('switch', { name: 'Auto-expand thinking' });
    expect(autoExpand.hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('switch', { name: 'Show thinking' }));
    expect(screen.getByRole('switch', { name: 'Auto-expand thinking' }).hasAttribute('disabled')).toBe(true);
  });

  it('shares "show gitignored files" with the file tree, both ways, under the same key', () => {
    function FileTreeButton() {
      const { showIgnored, toggleShowIgnored } = useShowIgnoredFiles();
      return <button type="button" data-testid="tree-eye" aria-pressed={showIgnored} onClick={toggleShowIgnored}>eye</button>;
    }
    renderTab();
    render(<FileTreeButton />);
    const settingsSwitch = () => screen.getByRole('switch', { name: 'Show gitignored files' });
    expect(settingsSwitch().getAttribute('aria-checked')).toBe('true');

    fireEvent.click(settingsSwitch());
    expect(localStorage.getItem('file-tree-show-ignored')).toBe('false');
    expect(screen.getByTestId('tree-eye').getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByTestId('tree-eye'));
    expect(localStorage.getItem('file-tree-show-ignored')).toBe('true');
    expect(settingsSwitch().getAttribute('aria-checked')).toBe('true');

    // Another browser tab changed it.
    act(() => {
      localStorage.setItem('file-tree-show-ignored', 'false');
      window.dispatchEvent(new StorageEvent('storage', { key: 'file-tree-show-ignored' }));
    });
    expect(settingsSwitch().getAttribute('aria-checked')).toBe('false');
    act(() => setShowIgnoredFiles(true));
  });
});

describe('mobileui translations', () => {
  it('registers the namespace and falls back to English', async () => {
    expect(i18n.hasResourceBundle('en', 'mobileui')).toBe(true);
    expect(i18n.hasResourceBundle('zh-CN', 'mobileui')).toBe(true);
    const fixed = i18n.getFixedT('cs', 'mobileui');
    // Czech has no own string for the section title, so English is used.
    expect(fixed('sections.look')).toBe('Look');
    expect(i18n.getFixedT('zh-CN', 'mobileui')('sections.look')).toBe('外观');
  });

  it('no longer keeps the moved strings in the settings namespace', () => {
    expect(i18n.exists('settings:serverSettings.title', { lng: 'en' })).toBe(false);
    expect(i18n.exists('settings:appearanceSettings.skin.label', { lng: 'en' })).toBe(false);
    expect(i18n.getFixedT('en', 'mobileui')('serverSettings.title')).toBe('Server');
  });
});
