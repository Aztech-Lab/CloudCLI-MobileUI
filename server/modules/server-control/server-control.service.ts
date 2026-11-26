// [local] Server control for the settings page: status, autostart, restart and stop of the
// server this process is, through the scripts in scripts/server/ that started it.
import path from 'node:path';

import { AppError } from '@/shared/utils.js';

type ServerControlInstance = 'live' | 'staging';

/**
 * Where the scripts that started this server live, read from the environment that
 * scripts/server/start sets. null when the server was started some other way.
 */
type ServerControlTarget = {
  scriptsDir: string;
  configPath: string | null;
  instance: ServerControlInstance;
};

type ServerControlScript = 'status' | 'autostart' | 'restart' | 'stop';

type ServerControlRequest = {
  script: ServerControlScript;
  action?: 'on' | 'off';
  json?: boolean;
  force?: boolean;
  detach?: boolean;
  delaySeconds?: number;
  deploy?: boolean;
};

type ScriptInvocation = { command: string; args: string[] };

type ScriptResult = { exitCode: number | null; stdout: string; stderr: string };

type ServerControlDependencies = {
  target: ServerControlTarget | null;
  platform: NodeJS.Platform;
  runScript(invocation: ScriptInvocation, timeoutMs: number): Promise<ScriptResult>;
};

const STATUS_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 30_000;
// Long enough for the HTTP response to reach the browser before the server goes down.
const DETACHED_DELAY_SECONDS = 3;

/** Reads the target from the variables scripts/server/start sets; used by the module entry. */
export function readServerControlTarget(environment: NodeJS.ProcessEnv): ServerControlTarget | null {
  const scriptsDir = environment.CLOUDCLI_SERVER_CONTROL_DIR?.trim();
  if (!scriptsDir) {
    return null;
  }
  return {
    scriptsDir,
    configPath: environment.CLOUDCLI_SERVER_CONTROL_CONFIG?.trim() || null,
    instance: environment.CLOUDCLI_SERVER_CONTROL_INSTANCE === 'staging' ? 'staging' : 'live',
  };
}

/**
 * The exact command for one script call: Windows PowerShell on Windows, POSIX sh elsewhere.
 * Exported for the service tests, which pin the arguments each platform gets.
 */
export function buildScriptInvocation(
  platform: NodeJS.Platform,
  target: ServerControlTarget,
  request: ServerControlRequest,
): ScriptInvocation {
  const windows = platform === 'win32';
  // Autostart always concerns the live server and has no instance switch.
  const staging = target.instance === 'staging' && request.script !== 'autostart';
  const flag = (name: string) => (windows ? `-${name[0].toUpperCase()}${name.slice(1)}` : `--${name}`);
  const args: string[] = [];
  if (request.action) args.push(request.action);
  if (request.json) args.push(flag('json'));
  if (staging) args.push(flag('staging'));
  if (request.force) args.push(flag('force'));
  if (request.detach) args.push(flag('detach'));
  if (request.delaySeconds !== undefined) args.push(flag('delay'), String(request.delaySeconds));
  if (request.deploy) args.push(flag('deploy'));
  if (target.configPath) args.push(flag('config'), target.configPath);

  if (windows) {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.win32.join(target.scriptsDir, `${request.script}.ps1`),
        ...args,
      ],
    };
  }
  return { command: '/bin/sh', args: [path.posix.join(target.scriptsDir, `${request.script}.sh`), ...args] };
}

/** Picks the JSON object out of script output (PowerShell may add a BOM or stray lines). */
function parseJsonOutput(stdout: string): Record<string, unknown> | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(stdout.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The last lines of a failed script's output, for the error shown in the settings page. */
function describeFailure(result: ScriptResult): string {
  const text = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).filter(Boolean).slice(-4).join('\n');
  return text || `exit code ${result.exitCode ?? 'unknown'}`;
}

/**
 * Creates the server-control service used by the server-control routes and its tests.
 * Script execution stays behind the injected runner.
 */
export function createServerControlService(dependencies: ServerControlDependencies) {
  const { target, platform } = dependencies;

  const requireTarget = (): ServerControlTarget => {
    if (!target) {
      throw new AppError('This server was not started by the scripts in scripts/server, so it cannot be controlled here.', {
        code: 'SERVER_CONTROL_UNAVAILABLE',
        statusCode: 404,
      });
    }
    return target;
  };

  const run = async (request: ServerControlRequest, timeoutMs: number): Promise<ScriptResult> => {
    const invocation = buildScriptInvocation(platform, requireTarget(), request);
    const result = await dependencies.runScript(invocation, timeoutMs);
    if (result.exitCode !== 0) {
      throw new AppError(`The ${request.script} script failed: ${describeFailure(result)}`, {
        code: 'SERVER_CONTROL_SCRIPT_FAILED',
        statusCode: 502,
      });
    }
    return result;
  };

  return {
    /** Whether the settings page offers the Server tab; instant, runs no script. */
    getAvailability() {
      return target ? { managed: true as const, instance: target.instance } : { managed: false as const };
    },

    /** Status of this server, or { managed: false } when no scripts started it. */
    async getStatus() {
      if (!target) {
        return { managed: false as const };
      }
      const result = await run({ script: 'status', json: true }, STATUS_TIMEOUT_MS);
      const status = parseJsonOutput(result.stdout);
      if (!status) {
        throw new AppError('The status script returned no status.', {
          code: 'SERVER_CONTROL_SCRIPT_FAILED',
          statusCode: 502,
        });
      }
      return { managed: true as const, instance: target.instance, platform, status };
    },

    /** Turns start-at-login on or off (live server only). */
    async setAutostart(enabled: boolean) {
      const current = requireTarget();
      if (current.instance !== 'live') {
        throw new AppError('Autostart applies to the live server only.', {
          code: 'SERVER_CONTROL_NOT_LIVE',
          statusCode: 409,
        });
      }
      const result = await run({ script: 'autostart', action: enabled ? 'on' : 'off', json: true }, ACTION_TIMEOUT_MS);
      const state = parseJsonOutput(result.stdout)?.state;
      return { autostart: typeof state === 'string' ? state : enabled ? 'on' : 'off' };
    },

    /**
     * Schedules a restart (optionally activating a prepared build) in a detached process,
     * so it outlives this server. The caller has confirmed any running work already.
     */
    async restart(options: { deploy: boolean }) {
      await run(
        { script: 'restart', force: true, detach: true, delaySeconds: DETACHED_DELAY_SECONDS, deploy: options.deploy },
        ACTION_TIMEOUT_MS,
      );
      return { scheduled: true as const, delaySeconds: DETACHED_DELAY_SECONDS };
    },

    /** Schedules a stop in a detached process, like restart. */
    async stop() {
      await run({ script: 'stop', force: true, detach: true, delaySeconds: DETACHED_DELAY_SECONDS }, ACTION_TIMEOUT_MS);
      return { scheduled: true as const, delaySeconds: DETACHED_DELAY_SECONDS };
    },
  };
}
