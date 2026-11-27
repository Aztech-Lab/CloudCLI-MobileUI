import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createServerControlRouter } from '../server-control.routes.js';
import { createServerControlService } from '../server-control.service.js';

type Invocation = { command: string; args: string[] };

/** Serves the routes over a service whose script runner only records what it was asked. */
async function withServer(
  target: Parameters<typeof createServerControlService>[0]['target'],
  run: (baseUrl: string, calls: Invocation[]) => Promise<void>,
): Promise<void> {
  const calls: Invocation[] = [];
  const service = createServerControlService({
    target,
    platform: 'linux',
    runScript: async (invocation) => {
      calls.push(invocation);
      const script = invocation.args[0];
      const stdout = script.endsWith('status.sh')
        ? '{"running":true,"autostart":"on"}'
        : script.endsWith('autostart.sh')
          ? `{"state":"${invocation.args[1]}"}`
          : 'scheduled';
      return { exitCode: 0, stdout, stderr: '' };
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/server-control', createServerControlRouter(service));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    res.status(appError?.statusCode ?? 500).json({ success: false, error: { code: appError?.code } });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/server-control`, calls);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

const target = { scriptsDir: '/clone/scripts/server', configPath: null, instance: 'live' as const };

test('GET /status reports an unmanaged server without running a script', async () => {
  await withServer(null, async (baseUrl, calls) => {
    const availability = await fetch(baseUrl);
    assert.deepEqual(await availability.json(), { success: true, data: { managed: false } });

    const response = await fetch(`${baseUrl}/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, data: { managed: false } });
    assert.equal(calls.length, 0);

    const restart = await fetch(`${baseUrl}/restart`, { method: 'POST' });
    assert.equal(restart.status, 404);
  });
});

test('GET /status returns the script status; GET / answers without running one', async () => {
  await withServer(target, async (baseUrl, calls) => {
    const availability = (await (await fetch(baseUrl)).json()) as { data: unknown };
    assert.deepEqual(availability.data, { managed: true, instance: 'live' });
    assert.equal(calls.length, 0);

    const body = (await (await fetch(`${baseUrl}/status`)).json()) as { data: unknown };
    assert.deepEqual(body.data, { managed: true, instance: 'live', platform: 'linux', status: { running: true, autostart: 'on' } });
  });
});

test('PUT /autostart needs a boolean and passes it on', async () => {
  await withServer(target, async (baseUrl, calls) => {
    const bad = await fetch(`${baseUrl}/autostart`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    });
    assert.equal(bad.status, 400);
    assert.equal(calls.length, 0);

    const off = await fetch(`${baseUrl}/autostart`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.deepEqual(await off.json(), { success: true, data: { autostart: 'off' } });
    assert.equal(calls[0].args[1], 'off');
  });
});

test('POST /restart and /stop answer 202 and schedule a detached script', async () => {
  await withServer(target, async (baseUrl, calls) => {
    const restart = await fetch(`${baseUrl}/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deploy: true }),
    });
    assert.equal(restart.status, 202);
    assert.deepEqual(await restart.json(), { success: true, data: { scheduled: true, delaySeconds: 3 } });
    assert.ok(calls[0].args.includes('--detach'));
    assert.ok(calls[0].args.includes('--deploy'));

    const plainRestart = await fetch(`${baseUrl}/restart`, { method: 'POST' });
    assert.equal(plainRestart.status, 202);
    assert.ok(!calls[1].args.includes('--deploy'));

    const stop = await fetch(`${baseUrl}/stop`, { method: 'POST' });
    assert.equal(stop.status, 202);
    assert.ok(calls[2].args[0].endsWith('stop.sh'));
    assert.ok(calls[2].args.includes('--detach'));
  });
});
