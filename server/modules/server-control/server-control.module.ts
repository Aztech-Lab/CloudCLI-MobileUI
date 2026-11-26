// [local] Wires the server-control service to real processes for the server entrypoint.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { createServerControlRouter } from './server-control.routes.js';
import { createServerControlService, readServerControlTarget } from './server-control.service.js';

const OUTPUT_LIMIT = 256 * 1024;

/** Runs a script without a shell and collects its output, killing it after the timeout. */
function runScript(
  invocation: { command: string; args: string[] },
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

const target = readServerControlTarget(process.env);
// Read once and removed, so processes this server starts (chats, shells, a dev server run
// from a chat) do not inherit them and offer to control this server as if it were their own.
delete process.env.CLOUDCLI_SERVER_CONTROL_DIR;
delete process.env.CLOUDCLI_SERVER_CONTROL_CONFIG;
delete process.env.CLOUDCLI_SERVER_CONTROL_INSTANCE;

/** Server-control router for the server entrypoint (mounted behind authentication). */
export const serverControlRoutes = createServerControlRouter(
  createServerControlService({
    // A folder that no longer exists (e.g. a deleted clone) means nothing can be controlled.
    target: target && fs.existsSync(target.scriptsDir) ? target : null,
    platform: process.platform,
    runScript,
  }),
);
