// [local] Server switches that Settings > MobileUI can set: a fixed whitelist of environment
// variables, stored in app_config and copied into process.env at startup (see
// apply-setting-overrides.ts) for every variable the environment or _server/config.json does
// not already set. The server's own configuration always wins. A saved value takes effect
// after the next restart; nothing here changes the running server.
//
// Nothing else is reachable through this file: not the CLI path, the database location, the
// address or ports, the firewall, the JWT secret, or any other app_config key.
import fs from 'node:fs';
import path from 'node:path';

import { AppError } from '@/shared/utils.js';

export type ServerSettingId =
  | 'codexRuntime'
  | 'toolApprovalTimeoutMs'
  | 'backgroundMaxHoldMs'
  | 'fileTreeMaxEntries'
  | 'extraReadRoots';

/** Where the value the running server uses came from. */
export type ServerSettingSource = 'config' | 'ui' | 'default';

type Dependencies = {
  /** True when `p` is an existing directory; injected for the tests. */
  isDirectory(p: string): boolean;
};

type ServerSettingDefinition = {
  id: ServerSettingId;
  envKey: string;
  /** Turns a request value into the environment string, or throws a 400 AppError. */
  parse(value: unknown, deps: Dependencies): string;
};

const MAX_EXTRA_READ_ROOTS = 20;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

function invalid(id: ServerSettingId, message: string): AppError {
  return new AppError(`${id}: ${message}`, { code: 'INVALID_SERVER_SETTING', statusCode: 400, details: { id } });
}

function parseInteger(id: ServerSettingId, value: unknown, min: number, max: number): string {
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < min || number > max) {
    throw invalid(id, `must be a whole number from ${min} to ${max}`);
  }
  return String(number);
}

function parseExtraReadRoots(value: unknown, deps: Dependencies): string {
  const id: ServerSettingId = 'extraReadRoots';
  if (!Array.isArray(value) || value.length === 0) throw invalid(id, 'must be a non-empty list of folders');
  if (value.length > MAX_EXTRA_READ_ROOTS) throw invalid(id, `at most ${MAX_EXTRA_READ_ROOTS} folders`);
  const roots: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) throw invalid(id, 'every entry must be a folder path');
    const trimmed = entry.trim();
    // ';' separates the entries in the environment variable.
    if (trimmed.includes(';')) throw invalid(id, 'a folder path cannot contain ";"');
    if (!path.isAbsolute(trimmed)) throw invalid(id, 'every folder must be an absolute path');
    const resolved = path.resolve(trimmed);
    if (!deps.isDirectory(resolved)) throw invalid(id, 'every folder must exist');
    if (!roots.includes(resolved)) roots.push(resolved);
  }
  return roots.join(';');
}

/** The whitelist, in display order. */
export const SERVER_SETTING_DEFINITIONS: readonly ServerSettingDefinition[] = [
  {
    id: 'codexRuntime',
    envKey: 'CLOUDCLI_CODEX_RUNTIME',
    parse(value) {
      if (value !== 'exec' && value !== 'appserver') throw invalid('codexRuntime', 'must be "exec" or "appserver"');
      return value;
    },
  },
  {
    id: 'toolApprovalTimeoutMs',
    envKey: 'CLAUDE_TOOL_APPROVAL_TIMEOUT_MS',
    // 10 seconds to 7 days.
    parse: (value) => parseInteger('toolApprovalTimeoutMs', value, 10_000, 7 * 24 * 60 * 60 * 1000),
  },
  {
    id: 'backgroundMaxHoldMs',
    envKey: 'CLOUDCLI_BG_MAX_HOLD_MS',
    // At least the 30-minute idle ceiling (claude-runtime.provider.ts ignores less), at most a timer's limit.
    parse: (value) => parseInteger('backgroundMaxHoldMs', value, 30 * 60 * 1000, MAX_TIMER_DELAY_MS),
  },
  {
    id: 'fileTreeMaxEntries',
    envKey: 'CLOUDCLI_FILE_TREE_MAX_ENTRIES',
    parse: (value) => parseInteger('fileTreeMaxEntries', value, 1_000, 200_000),
  },
  {
    id: 'extraReadRoots',
    envKey: 'CLOUDCLI_EXTRA_READ_ROOTS',
    parse: parseExtraReadRoots,
  },
];

const DEFINITIONS_BY_ID = new Map(SERVER_SETTING_DEFINITIONS.map((definition) => [definition.id, definition]));

/** The app_config key a setting is stored under. Namespaced, so it can never be another key. */
export function serverSettingStorageKey(envKey: string): string {
  return `mobileui.serverSetting.${envKey}`;
}

/** The value the running server uses for one setting, and where it came from. */
export type AppliedServerSetting = { source: ServerSettingSource; value: string | null };
export type AppliedServerSettings = Record<ServerSettingId, AppliedServerSetting>;

export const defaultDependencies: Dependencies = {
  isDirectory(p) {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
};

/**
 * Fills `env` from the stored values, only for keys the environment does not set (an empty
 * value counts as unset, as it does for every reader of these variables). A stored value
 * that no longer passes validation is skipped. Returns what each setting ended up as.
 * Never throws.
 */
export function applyServerSettingOverrides(options: {
  env: NodeJS.ProcessEnv;
  readStored(key: string): string | null;
  deps?: Dependencies;
  log?: (message: string) => void;
}): AppliedServerSettings {
  const { env, readStored } = options;
  const deps = options.deps ?? defaultDependencies;
  const applied = {} as AppliedServerSettings;
  const fromUi: string[] = [];
  const skipped: string[] = [];
  const platform = env.VITE_IS_PLATFORM === 'true';

  for (const definition of SERVER_SETTING_DEFINITIONS) {
    const current = env[definition.envKey];
    if (current !== undefined && current.trim() !== '') {
      applied[definition.id] = { source: 'config', value: current };
      continue;
    }
    applied[definition.id] = { source: 'default', value: null };
    if (platform) continue;
    try {
      const stored = readStored(serverSettingStorageKey(definition.envKey));
      if (!stored) continue;
      const value = definition.id === 'extraReadRoots'
        ? definition.parse(stored.split(';').filter((root) => deps.isDirectory(root)), deps)
        : definition.parse(stored, deps);
      env[definition.envKey] = value;
      applied[definition.id] = { source: 'ui', value };
      fromUi.push(definition.envKey);
    } catch {
      skipped.push(definition.envKey);
    }
  }

  // Key names only; values may be paths.
  if (fromUi.length > 0) options.log?.(`[server-settings] Using values saved in Settings > MobileUI for: ${fromUi.join(', ')}`);
  if (skipped.length > 0) options.log?.(`[server-settings] Ignored invalid saved values for: ${skipped.join(', ')}`);
  return applied;
}

let appliedAtStartup: AppliedServerSettings | null = null;

/** Recorded once by apply-setting-overrides.ts at startup. */
export function recordAppliedServerSettings(applied: AppliedServerSettings): void {
  appliedAtStartup = applied;
}

/** What startup applied; when it never ran, the environment as it is now. */
export function getAppliedServerSettings(env: NodeJS.ProcessEnv = process.env): AppliedServerSettings {
  if (appliedAtStartup) return appliedAtStartup;
  const applied = {} as AppliedServerSettings;
  for (const definition of SERVER_SETTING_DEFINITIONS) {
    const current = env[definition.envKey];
    applied[definition.id] = current !== undefined && current.trim() !== ''
      ? { source: 'config', value: current }
      : { source: 'default', value: null };
  }
  return applied;
}

type ServerSettingsStore = {
  get(key: string): string | null;
  set(key: string, value: string): void;
};

export type ServerSettingView = {
  id: ServerSettingId;
  envKey: string;
  source: ServerSettingSource;
  /** The value the running server uses (null: its built-in default). */
  running: string | null;
  /** The value saved here (null: none). Takes effect after a restart. */
  saved: string | null;
  /** Saved differs from what runs, and a restart would change it. */
  pendingRestart: boolean;
};

export type ServerSettingsOverview = {
  /** False on the hosted platform build: nothing here applies there. */
  available: boolean;
  instance: 'live' | 'staging' | null;
  settings: ServerSettingView[];
};

/** The service behind GET/PATCH /api/server-control/settings. */
export function createServerSettingsService(dependencies: {
  store: ServerSettingsStore;
  getApplied: () => AppliedServerSettings;
  instance: 'live' | 'staging' | null;
  isPlatform: boolean;
  deps?: Dependencies;
  log?: (message: string) => void;
}) {
  const deps = dependencies.deps ?? defaultDependencies;

  const readSaved = (envKey: string): string | null => dependencies.store.get(serverSettingStorageKey(envKey)) || null;

  const requireAvailable = () => {
    if (dependencies.isPlatform) {
      throw new AppError('Server switches are not available on this build.', {
        code: 'SERVER_SETTINGS_UNAVAILABLE',
        statusCode: 404,
      });
    }
  };

  const overview = (): ServerSettingsOverview => {
    const applied = dependencies.getApplied();
    return {
      available: true,
      instance: dependencies.instance,
      settings: SERVER_SETTING_DEFINITIONS.map((definition) => {
        const { source, value } = applied[definition.id];
        const saved = readSaved(definition.envKey);
        const runningFromHere = source === 'ui' ? value : null;
        return {
          id: definition.id,
          envKey: definition.envKey,
          source,
          running: value,
          saved,
          pendingRestart: source !== 'config' && saved !== runningFromHere,
        };
      }),
    };
  };

  return {
    getSettings(): ServerSettingsOverview {
      requireAvailable();
      return overview();
    },

    /**
     * Saves some settings (`null` clears one). All-or-nothing: every key is checked before
     * anything is written. Writes the database only.
     */
    updateSettings(body: unknown): ServerSettingsOverview {
      requireAvailable();
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new AppError('Expected an object of settings', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
      }
      const entries = Object.entries(body as Record<string, unknown>);
      if (entries.length === 0) {
        throw new AppError('No settings given', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
      }
      const applied = dependencies.getApplied();
      const writes: Array<{ envKey: string; value: string }> = [];
      for (const [id, value] of entries) {
        const definition = DEFINITIONS_BY_ID.get(id as ServerSettingId);
        if (!definition) {
          throw new AppError('Unknown server setting', { code: 'UNKNOWN_SERVER_SETTING', statusCode: 400 });
        }
        if (applied[definition.id].source === 'config') {
          throw new AppError(`${definition.id} is set by the server configuration`, {
            code: 'SERVER_SETTING_LOCKED',
            statusCode: 409,
            details: { id: definition.id },
          });
        }
        writes.push({ envKey: definition.envKey, value: value === null ? '' : definition.parse(value, deps) });
      }
      for (const write of writes) {
        dependencies.store.set(serverSettingStorageKey(write.envKey), write.value);
      }
      dependencies.log?.(`[server-settings] Saved (applies after restart): ${writes.map((write) => write.envKey).join(', ')}`);
      return overview();
    },
  };
}
