import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import {
  buildScriptInvocation,
  createServerControlService,
  readServerControlTarget,
} from '../server-control.service.js';

type Dependencies = Parameters<typeof createServerControlService>[0];
type Invocation = { command: string; args: string[] };

const liveTarget = { scriptsDir: '/clone/scripts/server', configPath: '/clone/_server/config.json', instance: 'live' as const };

function createService(overrides: Partial<Dependencies> = {}, stdout = '{"running":true}') {
  const calls: Invocation[] = [];
  const service = createServerControlService({
    target: liveTarget,
    platform: 'linux',
    runScript: async (invocation) => {
      calls.push(invocation);
      return { exitCode: 0, stdout, stderr: '' };
    },
    ...overrides,
  });
  return { service, calls };
}

test('the target comes from the variables the start script sets', () => {
  assert.equal(readServerControlTarget({}), null);
  assert.equal(readServerControlTarget({ CLOUDCLI_SERVER_CONTROL_DIR: '  ' }), null);
  assert.deepEqual(
    readServerControlTarget({
      CLOUDCLI_SERVER_CONTROL_DIR: '/clone/scripts/server',
      CLOUDCLI_SERVER_CONTROL_CONFIG: '/cfg.json',
      CLOUDCLI_SERVER_CONTROL_INSTANCE: 'staging',
    }),
    { scriptsDir: '/clone/scripts/server', configPath: '/cfg.json', instance: 'staging' },
  );
  assert.equal(readServerControlTarget({ CLOUDCLI_SERVER_CONTROL_DIR: '/x', CLOUDCLI_SERVER_CONTROL_INSTANCE: 'odd' })?.instance, 'live');
});

test('Windows calls the PowerShell script with PowerShell switches', () => {
  const invocation = buildScriptInvocation(
    'win32',
    { scriptsDir: 'C:\\clone\\scripts\\server', configPath: 'C:\\clone\\_server\\config.json', instance: 'staging' },
    { script: 'restart', force: true, detach: true, delaySeconds: 3, deploy: true },
  );
  assert.equal(invocation.command, 'powershell.exe');
  assert.deepEqual(invocation.args, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', 'C:\\clone\\scripts\\server\\restart.ps1',
    '-Staging', '-Force', '-Detach', '-Delay', '3', '-Deploy',
    '-Config', 'C:\\clone\\_server\\config.json',
  ]);
});

test('macOS and Linux call the sh script with long options', () => {
  const invocation = buildScriptInvocation('darwin', liveTarget, { script: 'status', json: true });
  assert.deepEqual(invocation, {
    command: '/bin/sh',
    args: ['/clone/scripts/server/status.sh', '--json', '--config', '/clone/_server/config.json'],
  });
});

test('autostart never gets the staging switch', () => {
  const invocation = buildScriptInvocation('linux', { ...liveTarget, instance: 'staging' }, { script: 'autostart', action: 'on', json: true });
  assert.deepEqual(invocation.args, ['/clone/scripts/server/autostart.sh', 'on', '--json', '--config', '/clone/_server/config.json']);
});

test('status says "not managed" without running anything when no scripts started the server', async () => {
  const { service, calls } = createService({ target: null });
  assert.deepEqual(await service.getStatus(), { managed: false });
  assert.equal(calls.length, 0);
  await assert.rejects(service.restart({ deploy: false }), (error: unknown) => error instanceof AppError && error.statusCode === 404);
});

test('status parses the JSON the script prints, even after a BOM or stray lines', async () => {
  const { service } = createService({}, '\uFEFFwarning: something\n{"running":true,"pid":42}\n');
  const result = await service.getStatus();
  assert.deepEqual(result, { managed: true, instance: 'live', platform: 'linux', status: { running: true, pid: 42 } });
});

test('a failing script becomes a 502 with the end of its output', async () => {
  const { service } = createService({
    runScript: async () => ({ exitCode: 1, stdout: 'line 1\nport 3001 is held by PID 7, which is not CloudCLI', stderr: '' }),
  });
  await assert.rejects(service.stop(), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /not CloudCLI/);
    return true;
  });
});

test('restart and stop always run detached and forced (the page asked the user already)', async () => {
  const { service, calls } = createService();
  assert.deepEqual(await service.restart({ deploy: true }), { scheduled: true, delaySeconds: 3 });
  assert.deepEqual(await service.stop(), { scheduled: true, delaySeconds: 3 });
  assert.deepEqual(calls[0].args, [
    '/clone/scripts/server/restart.sh', '--force', '--detach', '--delay', '3', '--deploy', '--config', '/clone/_server/config.json',
  ]);
  assert.deepEqual(calls[1].args, [
    '/clone/scripts/server/stop.sh', '--force', '--detach', '--delay', '3', '--config', '/clone/_server/config.json',
  ]);
});

test('autostart reports the state the script returns and is refused on the test portal', async () => {
  const { service, calls } = createService({}, '{"state":"disabled","name":"CloudCLI-MobileUI"}');
  assert.deepEqual(await service.setAutostart(true), { autostart: 'disabled' });
  assert.deepEqual(calls[0].args.slice(0, 3), ['/clone/scripts/server/autostart.sh', 'on', '--json']);

  const staging = createService({ target: { ...liveTarget, instance: 'staging' } });
  await assert.rejects(staging.service.setAutostart(false), (error: unknown) => error instanceof AppError && error.statusCode === 409);
  assert.equal(staging.calls.length, 0);
});
