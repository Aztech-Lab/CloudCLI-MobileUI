// [local] Server switches of Settings > MobileUI: whitelist, validation, precedence of the
// server configuration, and the startup step that fills the environment.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createServerSettingsRouter } from '../server-control.routes.js';
import {
  applyServerSettingOverrides,
  createServerSettingsService,
  serverSettingStorageKey,
  type AppliedServerSettings,
} from '../server-settings.js';

const ROOT_A = path.resolve('/data/a');
const ROOT_B = path.resolve('/data/b');
const deps = { isDirectory: (p: string) => p === ROOT_A || p === ROOT_B };

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

const allDefault = (): AppliedServerSettings => ({
  codexRuntime: { source: 'default', value: null },
  toolApprovalTimeoutMs: { source: 'default', value: null },
  backgroundMaxHoldMs: { source: 'default', value: null },
  fileTreeMaxEntries: { source: 'default', value: null },
  extraReadRoots: { source: 'default', value: null },
});

function service(options: { applied?: AppliedServerSettings; store?: ReturnType<typeof memoryStore>; isPlatform?: boolean } = {}) {
  const store = options.store ?? memoryStore();
  const logs: string[] = [];
  return {
    store,
    logs,
    service: createServerSettingsService({
      store,
      getApplied: () => options.applied ?? allDefault(),
      instance: 'live',
      isPlatform: options.isPlatform ?? false,
      deps,
      log: (message) => logs.push(message),
    }),
  };
}

const errorCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.code : 'NOT_APP_ERROR';
  }
  return undefined;
};

test('the overview lists exactly the five whitelisted switches', () => {
  const { service: settings } = service();
  const overview = settings.getSettings();
  assert.deepEqual(overview.settings.map((setting) => setting.envKey), [
    'CLOUDCLI_CODEX_RUNTIME',
    'CLAUDE_TOOL_APPROVAL_TIMEOUT_MS',
    'CLOUDCLI_BG_MAX_HOLD_MS',
    'CLOUDCLI_FILE_TREE_MAX_ENTRIES',
    'CLOUDCLI_EXTRA_READ_ROOTS',
  ]);
  assert.deepEqual(Object.keys(overview).sort(), ['available', 'instance', 'settings']);
  for (const setting of overview.settings) {
    assert.deepEqual(Object.keys(setting).sort(), ['envKey', 'id', 'pendingRestart', 'running', 'saved', 'source']);
  }
});

test('the overview does not leak other app_config keys', () => {
  const store = memoryStore({ jwt_secret: 'very-secret', 'browser-use-settings': '{}' });
  const { service: settings } = service({ store });
  const text = JSON.stringify(settings.getSettings());
  assert.equal(text.includes('very-secret'), false);
  assert.equal(text.includes('jwt'), false);
});

test('unknown keys, the JWT secret and other config keys are refused, and nothing is written', () => {
  const { service: settings, store } = service();
  for (const key of ['jwt_secret', 'JWT_SECRET', 'CLAUDE_CLI_PATH', 'DATABASE_PATH', 'HOST', 'SERVER_PORT', 'CLOUDCLI_CODEX_RUNTIME', '__proto__']) {
    assert.equal(errorCode(() => settings.updateSettings({ [key]: 'x' })), 'UNKNOWN_SERVER_SETTING', key);
  }
  // One bad key fails the whole request.
  assert.equal(errorCode(() => settings.updateSettings({ codexRuntime: 'appserver', jwt_secret: 'x' })), 'UNKNOWN_SERVER_SETTING');
  assert.equal(store.values.size, 0);
  assert.equal(errorCode(() => settings.updateSettings(null)), 'INVALID_REQUEST_BODY');
  assert.equal(errorCode(() => settings.updateSettings([])), 'INVALID_REQUEST_BODY');
  assert.equal(errorCode(() => settings.updateSettings({})), 'INVALID_REQUEST_BODY');
});

test('values are checked against their bounds', () => {
  const { service: settings } = service();
  const bad: Array<[string, unknown]> = [
    ['codexRuntime', 'turbo'],
    ['codexRuntime', 1],
    ['toolApprovalTimeoutMs', 9_999],
    ['toolApprovalTimeoutMs', 7 * 24 * 3600 * 1000 + 1],
    ['toolApprovalTimeoutMs', 60_000.5],
    ['toolApprovalTimeoutMs', '1e5'],
    ['backgroundMaxHoldMs', 30 * 60 * 1000 - 1],
    ['backgroundMaxHoldMs', 2 ** 31],
    ['fileTreeMaxEntries', 999],
    ['fileTreeMaxEntries', 200_001],
    ['extraReadRoots', []],
    ['extraReadRoots', 'not-a-list'],
    ['extraReadRoots', ['relative/path']],
    ['extraReadRoots', [`${ROOT_A};${ROOT_B}`]],
    ['extraReadRoots', [path.resolve('/missing')]],
    ['extraReadRoots', Array.from({ length: 21 }, () => ROOT_A)],
  ];
  for (const [id, value] of bad) {
    assert.equal(errorCode(() => settings.updateSettings({ [id]: value })), 'INVALID_SERVER_SETTING', `${id}=${JSON.stringify(value)}`);
  }
  for (const [id, value] of [
    ['codexRuntime', 'exec'],
    ['toolApprovalTimeoutMs', 10_000],
    ['toolApprovalTimeoutMs', 7 * 24 * 3600 * 1000],
    ['backgroundMaxHoldMs', 30 * 60 * 1000],
    ['backgroundMaxHoldMs', 2 ** 31 - 1],
    ['fileTreeMaxEntries', 1_000],
    ['fileTreeMaxEntries', 200_000],
  ] as Array<[string, unknown]>) {
    assert.equal(errorCode(() => settings.updateSettings({ [id]: value })), undefined, `${id}=${String(value)}`);
  }
});

test('saving writes namespaced keys only, logs key names only, and clears with null', () => {
  const { service: settings, store, logs } = service();
  const overview = settings.updateSettings({ codexRuntime: 'appserver', extraReadRoots: [ROOT_A, ROOT_B, ROOT_A] });
  assert.equal(store.get(serverSettingStorageKey('CLOUDCLI_CODEX_RUNTIME')), 'appserver');
  assert.equal(store.get(serverSettingStorageKey('CLOUDCLI_EXTRA_READ_ROOTS')), `${ROOT_A};${ROOT_B}`);
  assert.ok([...store.values.keys()].every((key) => key.startsWith('mobileui.serverSetting.')));
  const runtime = overview.settings.find((setting) => setting.id === 'codexRuntime');
  assert.deepEqual(runtime, {
    id: 'codexRuntime',
    envKey: 'CLOUDCLI_CODEX_RUNTIME',
    source: 'default',
    running: null,
    saved: 'appserver',
    pendingRestart: true,
  });
  assert.equal(logs.join('\n').includes(ROOT_A), false);
  assert.match(logs.join('\n'), /CLOUDCLI_CODEX_RUNTIME/);

  const cleared = settings.updateSettings({ codexRuntime: null });
  assert.equal(cleared.settings.find((setting) => setting.id === 'codexRuntime')?.saved, null);
  assert.equal(cleared.settings.find((setting) => setting.id === 'codexRuntime')?.pendingRestart, false);
});

test('a switch set by the server configuration is locked', () => {
  const applied = allDefault();
  applied.codexRuntime = { source: 'config', value: 'exec' };
  const { service: settings, store } = service({ applied });
  assert.equal(errorCode(() => settings.updateSettings({ codexRuntime: 'appserver' })), 'SERVER_SETTING_LOCKED');
  assert.equal(store.values.size, 0);
  const runtime = settings.getSettings().settings.find((setting) => setting.id === 'codexRuntime');
  assert.equal(runtime?.source, 'config');
  assert.equal(runtime?.running, 'exec');
  assert.equal(runtime?.pendingRestart, false);
});

test('the hosted platform build offers nothing', () => {
  const { service: settings } = service({ isPlatform: true });
  assert.equal(errorCode(() => settings.getSettings()), 'SERVER_SETTINGS_UNAVAILABLE');
  assert.equal(errorCode(() => settings.updateSettings({ codexRuntime: 'exec' })), 'SERVER_SETTINGS_UNAVAILABLE');
});

test('startup fills only unset variables; the environment wins and is reported as config', () => {
  const store = memoryStore({
    [serverSettingStorageKey('CLOUDCLI_CODEX_RUNTIME')]: 'appserver',
    [serverSettingStorageKey('CLOUDCLI_FILE_TREE_MAX_ENTRIES')]: '50000',
    [serverSettingStorageKey('CLAUDE_TOOL_APPROVAL_TIMEOUT_MS')]: '3600000',
    [serverSettingStorageKey('CLOUDCLI_EXTRA_READ_ROOTS')]: `${ROOT_A};${path.resolve('/gone')}`,
    [serverSettingStorageKey('CLOUDCLI_BG_MAX_HOLD_MS')]: '',
    [serverSettingStorageKey('CLAUDE_CLI_PATH')]: '/evil/claude',
  });
  const env: NodeJS.ProcessEnv = {
    CLOUDCLI_CODEX_RUNTIME: 'exec',
    // An empty value counts as unset, as it does for every reader of these variables.
    CLOUDCLI_FILE_TREE_MAX_ENTRIES: '',
  };
  const logs: string[] = [];
  const applied = applyServerSettingOverrides({ env, readStored: store.get, deps, log: (message) => logs.push(message) });

  assert.equal(env.CLOUDCLI_CODEX_RUNTIME, 'exec');
  assert.deepEqual(applied.codexRuntime, { source: 'config', value: 'exec' });
  assert.equal(env.CLOUDCLI_FILE_TREE_MAX_ENTRIES, '50000');
  assert.deepEqual(applied.fileTreeMaxEntries, { source: 'ui', value: '50000' });
  assert.equal(env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, '3600000');
  // A folder that disappeared since it was saved is left out.
  assert.equal(env.CLOUDCLI_EXTRA_READ_ROOTS, ROOT_A);
  assert.equal(env.CLOUDCLI_BG_MAX_HOLD_MS, undefined);
  assert.deepEqual(applied.backgroundMaxHoldMs, { source: 'default', value: null });
  // Never anything outside the whitelist.
  assert.equal(env.CLAUDE_CLI_PATH, undefined);
  assert.deepEqual(Object.keys(env).sort(), [
    'CLAUDE_TOOL_APPROVAL_TIMEOUT_MS',
    'CLOUDCLI_CODEX_RUNTIME',
    'CLOUDCLI_EXTRA_READ_ROOTS',
    'CLOUDCLI_FILE_TREE_MAX_ENTRIES',
  ]);
  assert.equal(logs.join('\n').includes(ROOT_A), false);
});

test('startup skips stored values that are no longer valid, and never throws', () => {
  const env: NodeJS.ProcessEnv = {};
  const applied = applyServerSettingOverrides({
    env,
    readStored: (key) => (key.endsWith('CLOUDCLI_FILE_TREE_MAX_ENTRIES') ? '5' : key.endsWith('CLOUDCLI_CODEX_RUNTIME') ? 'turbo' : null),
    deps,
  });
  assert.deepEqual(env, {});
  assert.equal(applied.fileTreeMaxEntries.source, 'default');

  const throwing = applyServerSettingOverrides({
    env,
    readStored: () => {
      throw new Error('database is locked');
    },
    deps,
  });
  assert.deepEqual(env, {});
  assert.equal(throwing.codexRuntime.source, 'default');
});

test('startup applies nothing on the hosted platform build', () => {
  const env: NodeJS.ProcessEnv = { VITE_IS_PLATFORM: 'true' };
  applyServerSettingOverrides({ env, readStored: () => 'appserver', deps });
  assert.equal(env.CLOUDCLI_CODEX_RUNTIME, undefined);
});

test('GET and PATCH /settings over HTTP', async () => {
  const { service: settings } = service();
  const app = express();
  app.use(express.json());
  app.use('/api/server-control/settings', createServerSettingsRouter(settings));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    res.status(appError?.statusCode ?? 500).json({ success: false, error: { code: appError?.code } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/server-control/settings`;
  try {
    const get = await fetch(baseUrl);
    assert.equal(get.status, 200);
    const body = (await get.json()) as { data: { settings: unknown[] } };
    assert.equal(body.data.settings.length, 5);

    const patch = (payload: unknown) => fetch(baseUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal((await patch({ fileTreeMaxEntries: 30_000 })).status, 200);
    assert.equal((await patch({ jwt_secret: 'x' })).status, 400);
    assert.equal((await patch({ fileTreeMaxEntries: 10 })).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
