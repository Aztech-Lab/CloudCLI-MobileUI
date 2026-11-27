import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import SettingsSidebar from '@/modules/settings/SettingsSidebar';
import { useServerControl } from '@/modules/settings/hooks/useServerControl';
import ServerSettingsTab from '@/modules/settings/tabs/ServerSettingsTab';
import type { ServerControlStatus } from '@/shared/types';

/**
 * Drives the Server tab through the real hook and api helpers against an
 * in-memory stand-in for /api/server-control.
 */

type Recorded = { method: string; url: string; body: unknown };

const RUNNING: ServerControlStatus = {
  instance: 'live',
  port: 3001,
  listenAddress: '127.0.0.1',
  running: true,
  pid: 4242,
  version: '1.37.9',
  activeWork: { turns: 1, backgroundSessions: 0, backgroundTasks: 2 },
  build: { branch: 'main', commit: 'abc1234', dirty: false, builtAt: '2026-11-25T10:00:00' },
  pendingBuild: { branch: 'main', commit: 'def5678', dirty: false, builtAt: '2026-11-25T11:00:00' },
  autostart: 'on',
  autostartName: 'CloudCLI-MobileUI',
};

let managed: boolean;
let status: ServerControlStatus;
let calls: Recorded[];

const json = (code: number, body: unknown) => new Response(JSON.stringify(body), {
  status: code,
  headers: { 'Content-Type': 'application/json' },
});

function fakeServer(url: string, init: RequestInit = {}): Response {
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, url, body });
  if (url === '/api/server-control') {
    return json(200, { success: true, data: managed ? { managed: true, instance: 'live' } : { managed: false } });
  }
  if (url === '/api/server-control/status') {
    return json(200, { success: true, data: managed ? { managed: true, instance: 'live', platform: 'win32', status } : { managed: false } });
  }
  if (url === '/api/server-control/autostart' && method === 'PUT') {
    status = { ...status, autostart: body.enabled ? 'on' : 'off' };
    return json(200, { success: true, data: { autostart: status.autostart } });
  }
  if ((url === '/api/server-control/restart' || url === '/api/server-control/stop') && method === 'POST') {
    return json(202, { success: true, data: { scheduled: true, delaySeconds: 3 } });
  }
  return json(404, { success: false, error: { code: 'NOT_FOUND', message: 'no route' } });
}

function Harness({ isActive = true }: { isActive?: boolean }) {
  const serverControl = useServerControl({ isOpen: true, isActive });
  return (
    <>
      <span data-testid="managed">{String(serverControl.managed)}</span>
      {isActive && <ServerSettingsTab serverControl={serverControl} />}
    </>
  );
}

beforeEach(() => {
  managed = true;
  status = RUNNING;
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => fakeServer(url, init)));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Settings > Server', () => {
  it('says so when the server was not started by the scripts', async () => {
    managed = false;
    render(<Harness />);
    expect(await screen.findByText(/not started by the scripts/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
  });

  it('knows whether to offer the tab without running the status script', async () => {
    render(<Harness isActive={false} />);
    await waitFor(() => expect(screen.getByTestId('managed').textContent).toBe('true'));
    expect(calls.map((call) => call.url)).toEqual(['/api/server-control']);
  });

  it('shows status, build, prepared build and running work', async () => {
    render(<Harness />);
    expect(await screen.findByText('Running on port 3001 (PID 4242)')).toBeTruthy();
    expect(screen.getByText('main abc1234, built 2026-11-25 10:00:00')).toBeTruthy();
    expect(screen.getByText('main def5678, built 2026-11-25 11:00:00')).toBeTruthy();
    expect(screen.getByText(/Replies being written: 1/)).toBeTruthy();
  });

  it('asks with the running work before restarting, and activates the prepared build', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));

    await screen.findByText(/Restarting/);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toMatch(/cannot be resumed.*Replies being written: 1/s);
    expect(calls.find((call) => call.url === '/api/server-control/restart')?.body).toEqual({ deploy: true });
  });

  it('does nothing when the user cancels a stop', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(calls.filter((call) => call.url === '/api/server-control/status').length).toBeGreaterThan(1));
    expect(calls.some((call) => call.url === '/api/server-control/stop')).toBe(false);
  });

  it('switches autostart off', async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Start at login' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Start at login' }).getAttribute('aria-checked')).toBe('false'));
    expect(calls.find((call) => call.url === '/api/server-control/autostart')?.body).toEqual({ enabled: false });
  });

  it('explains an entry the system switched off', async () => {
    status = { ...RUNNING, autostart: 'disabled' };
    render(<Harness />);
    expect(await screen.findByText(/Task Manager > Startup apps/)).toBeTruthy();
  });

  it('the sidebar leaves out hidden tabs', () => {
    render(<SettingsSidebar activeTab="agents" onChange={() => undefined} hiddenTabs={['server']} />);
    expect(screen.queryAllByText('Server')).toHaveLength(0);
    render(<SettingsSidebar activeTab="agents" onChange={() => undefined} />);
    expect(screen.queryAllByText('Server').length).toBeGreaterThan(0);
  });
});
