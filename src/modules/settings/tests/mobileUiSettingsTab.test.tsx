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
let settingsAvailable = true;
let patches: unknown[] = [];
type SettingRow = { id: string; envKey: string; source: 'config' | 'ui' | 'default'; running: string | null; saved: string | null; pendingRestart: boolean };
let settingRows: SettingRow[] = [];

const defaultRows = (): SettingRow[] => [
  ['codexRuntime', 'CLOUDCLI_CODEX_RUNTIME'],
  ['toolApprovalTimeoutMs', 'CLAUDE_TOOL_APPROVAL_TIMEOUT_MS'],
  ['backgroundMaxHoldMs', 'CLOUDCLI_BG_MAX_HOLD_MS'],
  ['fileTreeMaxEntries', 'CLOUDCLI_FILE_TREE_MAX_ENTRIES'],
  ['extraReadRoots', 'CLOUDCLI_EXTRA_READ_ROOTS'],
].map(([id, envKey]) => ({ id, envKey, source: 'default', running: null, saved: null, pendingRestart: false }));

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

function fakeServer(url: string, init: RequestInit = {}): Response {
  if (url === '/api/server-control') {
    return json({ success: true, data: managed ? { managed: true, instance: 'live' } : { managed: false } });
  }
  if (url === '/api/server-control/status') {
    return json({ success: true, data: managed ? { managed: true, instance: 'live', platform: 'win32', status: STATUS } : { managed: false } });
  }
  if (url === '/api/server-control/settings') {
    if (!settingsAvailable) return new Response('{}', { status: 404 });
    if (init.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      patches.push(body);
      settingRows = settingRows.map((row) => {
        if (!(row.id in body)) return row;
        const value = body[row.id];
        const saved = value === null ? null : Array.isArray(value) ? value.join(';') : String(value);
        return { ...row, saved, pendingRestart: saved !== (row.source === 'ui' ? row.running : null) };
      });
    }
    return json({ success: true, data: { available: true, instance: managed ? 'live' : null, settings: settingRows } });
  }
  if (url === '/api/server-control/restart') {
    return json({ success: true, data: { scheduled: true, delaySeconds: 3 } });
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
  settingsAvailable = true;
  patches = [];
  settingRows = defaultRows();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => fakeServer(url, init)));
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
    expect(headings()).toEqual(expect.arrayContaining(['Look', 'Conversation', 'Phone & navigation', 'Files', 'About this edition']));
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

  it('stores the phone and navigation switches', () => {
    renderTab();
    fireEvent.click(screen.getByRole('switch', { name: 'Swipe between tabs' }));
    expect(readUserPreference('mobileUi', null)).toEqual({ swipeNavigation: false });
    expect(screen.getByRole('switch', { name: 'Swipe between tabs' }).getAttribute('aria-checked')).toBe('false');
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

describe('Settings > MobileUI server switches', () => {
  it('shows where each value comes from and locks what the server configuration sets', async () => {
    settingRows = defaultRows().map((row) => (
      row.id === 'codexRuntime' ? { ...row, source: 'config', running: 'appserver' }
        : row.id === 'fileTreeMaxEntries' ? { ...row, source: 'ui', running: '30000', saved: '30000' }
          : row
    ));
    renderTab();
    expect(await screen.findByText('Agents & background')).toBeTruthy();
    const runtime = screen.getByRole('combobox', { name: 'Codex runtime' }) as HTMLSelectElement;
    expect(runtime.disabled).toBe(true);
    expect(runtime.value).toBe('appserver');
    expect(screen.getByText('Locked by server config')).toBeTruthy();
    expect(screen.getByText(/_server\/config\.json/)).toBeTruthy();
    expect(screen.getByText('Set here')).toBeTruthy();
    expect(screen.getAllByText('Default').length).toBeGreaterThan(0);
    expect(screen.getByText('Experimental')).toBeTruthy();
  });

  it('saves a preset, says it applies after a restart, and restarts after confirming when managed', async () => {
    managed = true;
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    renderTab();
    const timeout = await screen.findByRole('combobox', { name: 'Approval timeout' });
    fireEvent.change(timeout, { target: { value: '3600000' } });
    expect(await screen.findByText('Saved. Applies after the server restarts.')).toBeTruthy();
    expect(patches).toEqual([{ toolApprovalTimeoutMs: 3600000 }]);
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/server-control/restart')).toBe(true));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('asks to restart on the computer when the scripts did not start the server', async () => {
    renderTab();
    fireEvent.change(await screen.findByRole('combobox', { name: 'Background work limit' }), { target: { value: '86400000' } });
    expect(await screen.findByText('Restart the server on the computer to use it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restart now' })).toBeNull();
  });

  it('asks before adding an extra read-only folder', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    renderTab();
    const input = await screen.findByRole('textbox', { name: 'Add folder' });
    fireEvent.change(input, { target: { value: '/data/notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toMatch(/read every file under\n\/data\/notes/);
    expect(patches).toEqual([]);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    await waitFor(() => expect(patches).toEqual([{ extraReadRoots: ['/data/notes'] }]));
  });

  it('hides the switches when the server does not offer them', async () => {
    settingsAvailable = false;
    renderTab();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/server-control/settings')).toBe(true));
    expect(screen.queryByText('Agents & background')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Codex runtime' })).toBeNull();
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
