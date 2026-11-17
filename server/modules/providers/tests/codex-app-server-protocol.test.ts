import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODEX_APP_SERVER_PROTOCOL_USAGE } from '@/modules/providers/list/codex/codex-app-server.runtime.js';

/**
 * [local] Protocol guard for the Codex app-server runtime.
 *
 * `CODEX_APP_SERVER_PROTOCOL_USAGE` lists every app-server method and
 * notification the runtime relies on. They are checked twice:
 * - against `fixtures/codex-app-server-protocol.json`, the method lists of the
 *   Codex version this package pins, which must match the installed one; and
 * - against the schema the installed CLI generates right now
 *   (`codex app-server generate-json-schema --experimental`, no model, no
 *   network, a throwaway CODEX_HOME), when its binary can run here.
 *
 * Upgrading @openai/codex fails the first check until the fixture is
 * regenerated from the new schema (same command, then the four method lists
 * of ClientRequest, ClientNotification, ServerNotification and ServerRequest),
 * and a version that dropped a method the runtime uses fails both.
 */

type MethodLists = {
  clientRequests: string[];
  clientNotifications: string[];
  serverNotifications: string[];
  serverRequests: string[];
};

const require_ = createRequire(import.meta.url);
const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-app-server-protocol.json');

async function readFixture(): Promise<MethodLists & { codexVersion: string }> {
  return JSON.parse(await readFile(fixturePath, 'utf8'));
}

function assertUsageCovered(lists: MethodLists, where: string) {
  const checks: Array<[string, readonly string[], string[]]> = [
    ['client request', CODEX_APP_SERVER_PROTOCOL_USAGE.requests, lists.clientRequests],
    ['client notification', CODEX_APP_SERVER_PROTOCOL_USAGE.clientNotifications, lists.clientNotifications],
    ['server notification', CODEX_APP_SERVER_PROTOCOL_USAGE.notifications, lists.serverNotifications],
    ['server request', CODEX_APP_SERVER_PROTOCOL_USAGE.serverRequests, lists.serverRequests],
  ];
  for (const [kind, used, available] of checks) {
    const missing = used.filter((method) => !available.includes(method));
    assert.deepEqual(missing, [], `${where} no longer has the ${kind}(s) ${missing.join(', ')} the Codex app-server runtime uses`);
  }
}

async function readSchemaMethods(dir: string, name: string): Promise<string[]> {
  const schema = JSON.parse(await readFile(path.join(dir, `${name}.json`), 'utf8')) as {
    oneOf?: Array<{ properties?: { method?: { enum?: string[]; const?: string } } }>;
  };
  const methods = (schema.oneOf ?? []).flatMap((variant) => {
    const method = variant.properties?.method;
    return method?.enum ?? (method?.const ? [method.const] : []);
  });
  return [...new Set(methods)].sort();
}

test('the methods the runtime uses are the reviewed set', () => {
  // A snapshot: a new method here is a deliberate change, reviewed with the
  // runtime code that uses it (stage 2 added turn/steer).
  assert.deepEqual([...CODEX_APP_SERVER_PROTOCOL_USAGE.requests], [
    'initialize', 'thread/start', 'thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt', 'thread/unsubscribe',
  ]);
  assert.deepEqual(CODEX_APP_SERVER_PROTOCOL_USAGE.requestParams, {
    TurnStartParams: ['threadId', 'input', 'clientUserMessageId'],
    TurnSteerParams: ['threadId', 'input', 'expectedTurnId', 'clientUserMessageId'],
    TurnInterruptParams: ['threadId', 'turnId'],
  });
});

test('the pinned protocol fixture is for the installed Codex CLI', async () => {
  const fixture = await readFixture();
  const installed = (require_('@openai/codex/package.json') as { version: string }).version;
  assert.equal(
    fixture.codexVersion,
    installed,
    'The bundled @openai/codex changed: regenerate fixtures/codex-app-server-protocol.json from '
      + '`codex app-server generate-json-schema --experimental` and check the app-server runtime still works.',
  );
});

test('every app-server method the runtime uses is in the pinned protocol', async () => {
  const fixture = await readFixture();
  assertUsageCovered(fixture, `Codex ${fixture.codexVersion}`);
});

test('every app-server method the runtime uses is in the installed CLI\'s schema', async (t) => {
  let launcher: string;
  try {
    launcher = require_.resolve('@openai/codex/bin/codex.js');
  } catch {
    t.skip('@openai/codex is not installed');
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-codex-schema-'));
  try {
    const out = path.join(dir, 'schema');
    const result = spawnSync(process.execPath, [launcher, 'app-server', 'generate-json-schema', '--experimental', '--out', out], {
      // Never the user's own ~/.codex.
      env: { ...process.env, CODEX_HOME: dir },
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    if (result.status !== 0) {
      t.skip(`the bundled codex binary cannot run here: ${result.error?.message ?? result.stderr?.trim().split('\n').pop() ?? `exit ${result.status}`}`);
      return;
    }
    const lists: MethodLists = {
      clientRequests: await readSchemaMethods(out, 'ClientRequest'),
      clientNotifications: await readSchemaMethods(out, 'ClientNotification'),
      serverNotifications: await readSchemaMethods(out, 'ServerNotification'),
      serverRequests: await readSchemaMethods(out, 'ServerRequest'),
    };
    assertUsageCovered(lists, 'The installed Codex CLI');
    // The parameters the runtime sends and reads back (for steering: the
    // message id Codex echoes as the `userMessage` item's `clientId`).
    for (const [name, fields] of Object.entries(CODEX_APP_SERVER_PROTOCOL_USAGE.requestParams)) {
      const schema = JSON.parse(await readFile(path.join(out, 'v2', `${name}.json`), 'utf8')) as { properties?: Record<string, unknown> };
      const missing = fields.filter((field) => !(field in (schema.properties ?? {})));
      assert.deepEqual(missing, [], `The installed Codex CLI's ${name} no longer has ${missing.join(', ')}`);
    }
    const threadItem = await readFile(path.join(out, 'v2', 'ItemStartedNotification.json'), 'utf8');
    assert.match(threadItem, /"clientId"/, 'userMessage items no longer carry the clientId steering confirms delivery with');
    // The fixture is what the installed CLI generates, not a hand-edited list.
    const { codexVersion: _version, ...fixtureLists } = await readFixture();
    const { source: _source, ...pinned } = fixtureLists as MethodLists & { source?: string };
    assert.deepEqual(lists, pinned);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
