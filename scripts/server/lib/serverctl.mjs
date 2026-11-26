#!/usr/bin/env node
// [local] Cross-platform helper behind scripts/server/*.ps1 and *.sh.
//
// It reads the machine config, talks to /health, prepares and activates runtimes, and
// launches detached processes. The platform scripts keep what only the OS can do
// (finding and stopping the process on a port, autostart, firewall) and call this for
// the rest, so both families behave the same.
//
// Uses only Node built-ins: setup runs it before `npm ci`.
//
//   node serverctl.mjs <command> [--config <file>] [options]
//
// Commands (output is JSON unless --format sh is given):
//   config        [--instance live|staging] [--port N] [--format json|sh]
//   env           --instance live|staging [--local] [--port N] [--format json|sh]
//   health        [--instance ...] [--port N] [--timeout ms]   exit 0 = up, 3 = down
//   work          [--instance ...] [--port N] [--action word]  exit 4 = work is running (described)
//   wait-health   [--instance ...] [--port N] [--timeout s]    exit 0 = up, 3 = timed out
//   port-open     [--instance ...] [--port N]                  exit 0 = something listens
//   status        [--instance ...] [--port N] [--pid N] [--foreign-pid N] [--autostart S] [--format json|text]
//   deploy        [--instance ...] [--from <dir>] [--build] [--fresh-db]
//   activate      [--instance ...]
//   init-config   --port N [--listen A] [--allow a,b] [--claude-path P] [--force]
//   check-node
//   spawn-detached --log <file> [--cwd <dir>] -- <command> [args...]

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLONE_ROOT = path.resolve(SCRIPTS_DIR, '..', '..');
const TEMPLATE_PATH = path.join(SCRIPTS_DIR, 'config.template.jsonc');
const CLI_RELATIVE_PATH = path.join('dist-server', 'server', 'modules', 'cli', 'cli.js');
const DEFAULT_AUTOSTART_NAME = 'CloudCLI-MobileUI';
const IS_WINDOWS = process.platform === 'win32';

/** A problem with the machine config that the user has to fix; printed without a stack. */
export class ConfigError extends Error {}

// ---------------------------------------------------------------------------------------
// Config file

/**
 * Removes // and block comments and trailing commas from JSONC text, leaving strings
 * untouched, so the result parses with JSON.parse.
 */
export function stripJsonc(text) {
  let withoutComments = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      withoutComments += char;
      if (char === '\\') {
        withoutComments += text[i + 1] ?? '';
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      withoutComments += char;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      withoutComments += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
    } else {
      withoutComments += char;
    }
  }

  // Second pass: drop a comma when the next meaningful character closes an object or array.
  let result = '';
  inString = false;
  for (let i = 0; i < withoutComments.length; i += 1) {
    const char = withoutComments[i];
    if (inString) {
      result += char;
      if (char === '\\') {
        result += withoutComments[i + 1] ?? '';
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') inString = true;
    if (char === ',') {
      let j = i + 1;
      while (j < withoutComments.length && /\s/.test(withoutComments[j])) j += 1;
      if (withoutComments[j] === '}' || withoutComments[j] === ']') continue;
    }
    result += char;
  }
  return result;
}

/** Parses JSONC (JSON with comments and trailing commas). */
export function parseJsonc(text, source = 'config') {
  try {
    return JSON.parse(stripJsonc(text.replace(/^\uFEFF/, '')));
  } catch (error) {
    throw new ConfigError(`${source} is not valid JSON: ${error.message}`);
  }
}

/** Where the machine config lives: $CLOUDCLI_SERVER_CONFIG, else <clone>/_server/config.json. */
export function defaultConfigPath(env = process.env, cloneRoot = CLONE_ROOT) {
  return env.CLOUDCLI_SERVER_CONFIG
    ? path.resolve(env.CLOUDCLI_SERVER_CONFIG)
    : path.join(cloneRoot, '_server', 'config.json');
}

/** Expands a leading ~ and ${VAR} (and %VAR% on Windows) in a config value. */
export function expandValue(value, env = process.env, home = os.homedir(), windows = IS_WINDOWS) {
  let expanded = String(value);
  if (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = home + expanded.slice(1);
  }
  const lookup = (name) => {
    if (windows) {
      const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
      return key === undefined ? '' : env[key] ?? '';
    }
    return env[name] ?? '';
  };
  expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => lookup(name));
  if (windows) {
    expanded = expanded.replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (match, name) => {
      const value = lookup(name);
      return value === '' ? match : value;
    });
  }
  return expanded;
}

/** True for an IPv4 address or IPv4 CIDR such as 192.168.1.0/24. */
export function isValidIpv4Cidr(value) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(String(value).trim());
  if (!match) return false;
  const octetsOk = match.slice(1, 5).every((octet) => Number(octet) <= 255);
  const bits = match[5] === undefined ? 32 : Number(match[5]);
  return octetsOk && bits >= 0 && bits <= 32;
}

function readPort(value, name, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === '' || value === 0)) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`${name} must be a port number (1-65535), got ${JSON.stringify(value)}`);
  }
  return port;
}

function readEnvMap(value, name, env, home, windows) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${name} must be an object of NAME: "value" pairs`);
  }
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ConfigError(`${name}: "${key}" is not a valid environment variable name`);
    }
    if (raw === null || raw === '') {
      // An empty value means "make sure it is NOT set", e.g. to drop an inherited variable.
      result[key] = null;
    } else if (['string', 'number', 'boolean'].includes(typeof raw)) {
      result[key] = expandValue(String(raw), env, home, windows);
    } else {
      throw new ConfigError(`${name}.${key} must be a string`);
    }
  }
  return result;
}

/**
 * Validates a parsed config object and fills in defaults. Relative paths are resolved
 * against the clone root, so a config can keep the runtime next to or outside the clone.
 */
export function resolveConfig(raw, {
  configPath,
  cloneRoot = CLONE_ROOT,
  env = process.env,
  home = os.homedir(),
  windows = IS_WINDOWS,
} = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('the config must be a JSON object');
  }
  const port = readPort(raw.port ?? 3001, 'port');
  const stagingPort = readPort(raw.stagingPort, 'stagingPort', { optional: true });
  if (stagingPort !== null && stagingPort === port) {
    throw new ConfigError('stagingPort must differ from port');
  }

  const listenAddress = String(raw.listenAddress ?? '127.0.0.1').trim() || '127.0.0.1';

  const allowRaw = raw.firewallAllow ?? [];
  if (!Array.isArray(allowRaw)) throw new ConfigError('firewallAllow must be a list of networks');
  const firewallAllow = allowRaw.map((entry) => String(entry).trim()).filter(Boolean);
  for (const entry of firewallAllow) {
    if (!isValidIpv4Cidr(entry)) {
      throw new ConfigError(`firewallAllow: "${entry}" is not an IPv4 network like 192.168.1.0/24`);
    }
  }

  const rawPaths = raw.paths ?? {};
  if (typeof rawPaths !== 'object' || Array.isArray(rawPaths)) throw new ConfigError('paths must be an object');
  const resolvePath = (key, fallback) => {
    const value = rawPaths[key] ?? fallback;
    if (typeof value !== 'string' || value.trim() === '') throw new ConfigError(`paths.${key} must be a path`);
    return path.resolve(cloneRoot, expandValue(value.trim(), env, home, windows));
  };
  const paths = {
    runtime: resolvePath('runtime', '_server/runtime'),
    staging: resolvePath('staging', '_server/staging'),
    logs: resolvePath('logs', '_server/logs'),
    backups: resolvePath('backups', '_server/backup'),
  };

  const autostartName = String(raw.autostartName ?? DEFAULT_AUTOSTART_NAME);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(autostartName)) {
    throw new ConfigError('autostartName may only contain letters, digits, ".", "_" and "-"');
  }

  const backupsToKeep = raw.backupsToKeep === undefined ? 3 : Number(raw.backupsToKeep);
  if (!Number.isInteger(backupsToKeep) || backupsToKeep < 0) {
    throw new ConfigError('backupsToKeep must be a whole number');
  }

  return {
    configPath: configPath ? path.resolve(configPath) : null,
    cloneRoot,
    scriptsDir: path.join(cloneRoot, 'scripts', 'server'),
    port,
    stagingPort,
    listenAddress,
    firewallAllow,
    env: readEnvMap(raw.env, 'env', env, home, windows),
    stagingEnv: readEnvMap(raw.stagingEnv, 'stagingEnv', env, home, windows),
    paths,
    autostartName,
    backupsToKeep,
  };
}

/** Reads and resolves the config file; a missing file is a ConfigError pointing at setup. */
export function loadConfig(configPath = defaultConfigPath(), options = {}) {
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(
      `No machine config at ${configPath}. Run scripts/server/setup (setup.ps1 on Windows, setup.sh elsewhere) first.`,
    );
  }
  const raw = parseJsonc(fs.readFileSync(configPath, 'utf8'), configPath);
  return resolveConfig(raw, { configPath, ...options });
}

/** The address a local health check should use for a listen address. */
export function healthHost(listenAddress) {
  return ['', '0.0.0.0', '::', '[::]', '127.0.0.1', 'localhost'].includes(listenAddress)
    ? '127.0.0.1'
    : listenAddress;
}

/** Ports, folders and log files of the live server or the test portal ("staging"). */
export function resolveInstance(config, name = 'live', { port } = {}) {
  const logs = config.paths.logs;
  if (name === 'staging') {
    if (config.stagingPort === null && !port) {
      throw new ConfigError('No test portal configured: set "stagingPort" in the config first.');
    }
    const dir = config.paths.staging;
    const runtime = path.join(dir, 'runtime');
    return finishInstance(config, {
      name: 'staging',
      port: port || config.stagingPort,
      runtime,
      next: path.join(dir, 'runtime.next'),
      previous: path.join(dir, 'runtime.prev'),
      db: path.join(dir, 'auth.db'),
      serverLog: path.join(logs, 'staging.log'),
      restartLog: path.join(logs, 'restart-staging.log'),
    });
  }
  if (name !== 'live') throw new ConfigError(`unknown instance "${name}" (use live or staging)`);
  return finishInstance(config, {
    name: 'live',
    port: port || config.port,
    runtime: config.paths.runtime,
    next: `${config.paths.runtime}.next`,
    previous: null,
    db: null,
    serverLog: path.join(logs, 'cloudcli.log'),
    restartLog: path.join(logs, 'restart.log'),
  });
}

function finishInstance(config, instance) {
  const host = healthHost(config.listenAddress);
  const urlHost = host.includes(':') ? `[${host}]` : host;
  return {
    ...instance,
    cli: path.join(instance.runtime, CLI_RELATIVE_PATH),
    deployLog: path.join(config.paths.logs, 'deploy.log'),
    healthUrl: `http://${urlHost}:${instance.port}/health`,
  };
}

/**
 * The environment the server process gets: what to set and what to remove. Variables a
 * caller may have inherited from another instance (for example a restart launched from a
 * chat inside the test portal) are removed, so they never leak into this one.
 */
export function serverEnvironment(config, instance, { local = false } = {}) {
  const set = {};
  const unset = new Set(['VITE_IS_PLATFORM', 'DATABASE_PATH', ...Object.keys(config.stagingEnv)]);
  const apply = (map) => {
    for (const [key, value] of Object.entries(map)) {
      if (value === null) {
        delete set[key];
        unset.add(key);
      } else {
        set[key] = value;
        unset.delete(key);
      }
    }
  };
  apply(config.env);
  if (instance.name === 'staging') {
    apply(config.stagingEnv);
    apply({ DATABASE_PATH: instance.db });
  }
  apply({
    HOST: local ? '127.0.0.1' : config.listenAddress,
    SERVER_PORT: String(instance.port),
    // Read by the server's settings page (server-control module) to offer restart/stop.
    CLOUDCLI_SERVER_CONTROL_DIR: config.scriptsDir,
    CLOUDCLI_SERVER_CONTROL_CONFIG: config.configPath ?? '',
    CLOUDCLI_SERVER_CONTROL_INSTANCE: instance.name,
  });
  // Never enable platform mode: it bypasses all authentication.
  delete set.VITE_IS_PLATFORM;
  unset.add('VITE_IS_PLATFORM');
  return { set, unset: [...unset].sort() };
}

/** Gives the test portal its own copy of the login database, taken once. */
function prepareStagingDatabase(config, instance) {
  if (instance.name !== 'staging' || fs.existsSync(instance.db)) return;
  const source = config.env.DATABASE_PATH || path.join(os.homedir(), '.cloudcli', 'auth.db');
  fs.mkdirSync(path.dirname(instance.db), { recursive: true });
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, instance.db);
    process.stderr.write(`staging: copied the database from ${source}\n`);
  } else {
    process.stderr.write(`staging: no database at ${source}; the test portal starts with an empty one\n`);
  }
}

// ---------------------------------------------------------------------------------------
// Making a config from the template

/**
 * Fills the committed template with setup's answers, keeping its comments. Each value
 * setup can set sits on its own line in the template.
 */
export function renderConfigFromTemplate(template, answers) {
  let text = template;
  const replaceValue = (key, value) => {
    const pattern = new RegExp(`^([ \\t]*"${key}"[ \\t]*:[ \\t]*)([^\\n]*?)(,?)([ \\t\\r]*)$`, 'm');
    if (!pattern.test(text)) throw new Error(`template has no line for "${key}"`);
    text = text.replace(pattern, (_m, prefix, _old, comma, trailing) => `${prefix}${JSON.stringify(value)}${comma}${trailing}`);
  };
  if (answers.port !== undefined) replaceValue('port', Number(answers.port));
  if (answers.listenAddress !== undefined) replaceValue('listenAddress', answers.listenAddress);
  if (answers.firewallAllow !== undefined) replaceValue('firewallAllow', answers.firewallAllow);
  if (answers.claudeCliPath !== undefined) replaceValue('CLAUDE_CLI_PATH', answers.claudeCliPath);
  // Must still be a valid config.
  resolveConfig(parseJsonc(text, 'generated config'), { configPath: 'generated' });
  return text;
}

// ---------------------------------------------------------------------------------------
// Health

/** Queries /health with a short timeout (no hanging loops). */
export async function queryHealth(url, timeoutMs = 3000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { up: false, error: `HTTP ${response.status}` };
    const body = await response.json();
    const work = body.activeWork ?? null;
    return {
      up: true,
      version: body.version ?? null,
      activeWork: work
        ? {
            turns: Number(work.turns) || 0,
            backgroundSessions: Number(work.backgroundSessions) || 0,
            backgroundTasks: Number(work.backgroundTasks) || 0,
          }
        : null,
    };
  } catch (error) {
    return { up: false, error: error?.cause?.code || error?.name || String(error) };
  }
}

/** True when a restart or stop would end running work. */
export function isBusy(activeWork) {
  return Boolean(activeWork && (activeWork.turns > 0 || activeWork.backgroundSessions > 0 || activeWork.backgroundTasks > 0));
}

function isPortOpen(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

// ---------------------------------------------------------------------------------------
// Builds

function readBuildInfo(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '.build.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function localTimestamp(date = new Date(), compact = false) {
  const day = `${date.getFullYear()}${compact ? '' : '-'}${pad(date.getMonth() + 1)}${compact ? '' : '-'}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${compact ? '' : ':'}${pad(date.getMinutes())}${compact ? '' : ':'}${pad(date.getSeconds())}`;
  return compact ? `${day}-${time}` : `${day} ${time}`;
}

function createLogger(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return (message) => {
    const line = `${localTimestamp()} ${message}`;
    fs.appendFileSync(file, `${line}\n`);
    process.stdout.write(`${line}\n`);
  };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Renames with retries: on Windows a just-stopped process can hold files for a moment. */
function renameWithRetry(from, to, attempts = 15) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      sleepSync(1000);
    }
  }
}

function shellQuote(arg) {
  if (/^[\w@%+=:,./\\-]+$/.test(arg)) return arg;
  return IS_WINDOWS ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs a command with its output appended to the log file. npm is a .cmd shim on Windows,
 * which Node only starts through a shell, so commands go through one as a single string.
 */
function runLogged(log, logFile, what, command, args, cwd) {
  const fd = fs.openSync(logFile, 'a');
  try {
    const result = spawnSync([command, ...args].map(shellQuote).join(' '), {
      cwd,
      shell: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    if (result.status !== 0) {
      log(`FAILED: ${what} (exit ${result.status ?? result.error?.message ?? 'unknown'}; details in ${logFile})`);
      process.exit(1);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function gitOutput(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Packs a built checkout into <runtime>.next with production dependencies installed from
 * its package-lock.json, without touching the running server.
 */
function deploy(config, instance, { from, build, freshDb }) {
  const source = path.resolve(from || config.cloneRoot);
  const logFile = instance.deployLog;
  const log = createLogger(logFile);
  log(`deploy: preparing ${path.basename(instance.next)}${instance.name === 'staging' ? ' (staging)' : ''} from ${source}`);

  if (instance.name === 'staging') {
    fs.mkdirSync(path.dirname(instance.runtime), { recursive: true });
    if (freshDb) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${instance.db}${suffix}`, { force: true });
      log('deploy: the test portal takes a new copy of the database on its next start');
    }
  }

  if (build) runLogged(log, logFile, 'npm run build', 'npm', ['run', 'build'], source);
  if (!fs.existsSync(path.join(source, 'dist', 'index.html')) || !fs.existsSync(path.join(source, CLI_RELATIVE_PATH))) {
    log(`FAILED: ${source} has no build (run npm run build there, or pass the build option)`);
    process.exit(1);
  }

  const commit = gitOutput(source, ['rev-parse', '--short', 'HEAD']) ?? 'unknown';
  const branch = gitOutput(source, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown';
  const dirty = Boolean(gitOutput(source, ['status', '--porcelain', '--untracked-files=no']));

  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudcli-pack-'));
  try {
    runLogged(log, logFile, 'npm pack', 'npm', ['pack', '--ignore-scripts', '--pack-destination', packDir], source);
    const tarball = fs.readdirSync(packDir).find((name) => name.endsWith('.tgz'));
    if (!tarball) {
      log('FAILED: npm pack produced no package');
      process.exit(1);
    }

    fs.rmSync(instance.next, { recursive: true, force: true, maxRetries: 5 });
    fs.mkdirSync(instance.next, { recursive: true });
    // Windows' own bsdtar: a GNU tar from Git or MSYS on PATH reads "C:" as a remote host.
    const systemTar = IS_WINDOWS ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const tar = IS_WINDOWS && !fs.existsSync(systemTar) ? 'tar' : systemTar;
    runLogged(log, logFile, 'unpack', tar, ['-xzf', path.join(packDir, tarball), '-C', instance.next, '--strip-components', '1'], packDir);
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
  }
  fs.copyFileSync(path.join(source, 'package-lock.json'), path.join(instance.next, 'package-lock.json'));

  // Root lifecycle scripts (husky) are dev tooling: install without scripts, then build
  // the dependencies that need it (native modules, ripgrep, esbuild).
  runLogged(log, logFile, 'npm ci', 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], instance.next);
  runLogged(log, logFile, 'npm rebuild', 'npm', ['rebuild'], instance.next);
  runLogged(
    log,
    logFile,
    'native modules load',
    process.execPath,
    ['-e', "require('better-sqlite3'); require('node-pty'); console.log('native modules ok')"],
    instance.next,
  );

  const builtAt = localTimestamp().replace(' ', 'T');
  fs.writeFileSync(
    path.join(instance.next, '.build.json'),
    `${JSON.stringify({ branch, commit, dirty, builtAt }, null, 2)}\n`,
  );
  log(
    `deploy: ${path.basename(instance.next)} ready${instance.name === 'staging' ? ' (staging)' : ''} from ${branch} ${commit}` +
      `${dirty ? ', with uncommitted changes' : ''}. Activate it with restart --deploy.`,
  );
}

/**
 * Makes <runtime>.next the running build while the server is stopped. The live server
 * keeps old builds in the backups folder (the newest few); the test portal keeps one.
 */
function activate(config, instance) {
  const log = createLogger(instance.restartLog);
  if (!fs.existsSync(path.join(instance.next, CLI_RELATIVE_PATH))) {
    log(`deploy: no ${instance.next} to activate; starting the current build`);
    return;
  }
  if (instance.name === 'staging') {
    if (fs.existsSync(instance.previous)) fs.rmSync(instance.previous, { recursive: true, force: true, maxRetries: 5 });
    if (fs.existsSync(instance.runtime)) renameWithRetry(instance.runtime, instance.previous);
    renameWithRetry(instance.next, instance.runtime);
    log('deploy: staging runtime.next activated (previous kept as runtime.prev)');
    return;
  }
  fs.mkdirSync(config.paths.backups, { recursive: true });
  if (fs.existsSync(instance.runtime)) {
    const keep = path.join(config.paths.backups, `runtime-${localTimestamp(new Date(), true)}`);
    renameWithRetry(instance.runtime, keep);
    log(`deploy: previous build moved to ${keep}`);
  }
  renameWithRetry(instance.next, instance.runtime);
  log('deploy: runtime.next activated');
  const old = fs.readdirSync(config.paths.backups, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('runtime-'))
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .slice(config.backupsToKeep);
  for (const name of old) {
    fs.rmSync(path.join(config.paths.backups, name), { recursive: true, force: true, maxRetries: 5 });
    log(`deploy: pruned old build ${name}`);
  }
}

// ---------------------------------------------------------------------------------------
// Status

/** Everything the status scripts and the settings page show, in one object. */
export function buildStatus(config, instance, { pid, foreignPid, autostart, health }) {
  const running = Boolean(pid) || Boolean(health?.up && !foreignPid);
  return {
    instance: instance.name,
    port: instance.port,
    listenAddress: config.listenAddress,
    running,
    pid: pid || null,
    foreignPid: foreignPid || null,
    version: health?.up ? health.version : null,
    activeWork: health?.up ? health.activeWork : null,
    build: readBuildInfo(instance.runtime),
    pendingBuild: readBuildInfo(instance.next),
    autostart: autostart || 'unknown',
    autostartName: config.autostartName,
    configPath: config.configPath,
    logs: { server: instance.serverLog, restart: instance.restartLog, deploy: instance.deployLog },
  };
}

function formatStatusText(status) {
  const lines = [];
  const label = status.instance === 'staging' ? 'Test portal' : 'Server';
  if (status.running) {
    lines.push(`${label}: running on port ${status.port}${status.pid ? ` (pid ${status.pid})` : ''}${status.version ? `, version ${status.version}` : ''}`);
  } else if (status.foreignPid) {
    lines.push(`${label}: NOT running; port ${status.port} is held by another program (pid ${status.foreignPid})`);
  } else {
    lines.push(`${label}: stopped (port ${status.port})`);
  }
  const describeBuild = (build) => (build ? `${build.branch} ${build.commit}${build.dirty ? ' (uncommitted changes)' : ''}, built ${build.builtAt}` : 'none');
  lines.push(`Build: ${describeBuild(status.build)}`);
  if (status.pendingBuild) lines.push(`Prepared build (activates on restart --deploy): ${describeBuild(status.pendingBuild)}`);
  if (status.activeWork) {
    const work = status.activeWork;
    lines.push(`Active work: ${work.turns} turn(s), ${work.backgroundSessions} session(s) with background work, ${work.backgroundTasks} background task(s)`);
  }
  if (status.instance === 'live') lines.push(`Autostart at login: ${status.autostart}`);
  lines.push(`Listen address: ${status.listenAddress}`);
  lines.push(`Log: ${status.logs.server}`);
  lines.push(`Config: ${status.configPath}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------
// Node version

/** Lowest major Node version from package.json "engines.node" (">=22" style), or null. */
export function requiredNodeMajor(packageJson) {
  const spec = packageJson?.engines?.node;
  const match = spec ? /(\d+)/.exec(spec) : null;
  return match ? Number(match[1]) : null;
}

// ---------------------------------------------------------------------------------------
// Command line

function parseArgs(argv) {
  const options = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      i += 1;
    }
  }
  return { options, rest };
}

function shAssignments(values) {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${shellQuoteSh(value === null || value === undefined ? '' : String(value))}`)
    .join('\n');
}

function shellQuoteSh(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function print(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

async function main(argv) {
  const [command, ...args] = argv;
  const { options, rest } = parseArgs(args);
  const configPath = options.config && options.config !== true ? path.resolve(options.config) : defaultConfigPath();
  const instanceName = typeof options.instance === 'string' ? options.instance : 'live';
  const portOverride = options.port && options.port !== true ? readPort(options.port, '--port') : undefined;
  const format = typeof options.format === 'string' ? options.format : 'json';
  const load = () => {
    const config = loadConfig(configPath);
    return { config, instance: resolveInstance(config, instanceName, { port: portOverride }) };
  };

  switch (command) {
    case 'config': {
      const config = loadConfig(configPath);
      const instance = options.instance || portOverride ? resolveInstance(config, instanceName, { port: portOverride }) : null;
      if (format === 'sh') {
        print(shAssignments({
          CFG_CONFIG_PATH: config.configPath,
          CFG_CLONE_ROOT: config.cloneRoot,
          CFG_PORT: config.port,
          CFG_STAGING_PORT: config.stagingPort ?? '',
          CFG_LISTEN: config.listenAddress,
          CFG_ALLOW: config.firewallAllow.join(' '),
          CFG_RUNTIME: config.paths.runtime,
          CFG_STAGING_DIR: config.paths.staging,
          CFG_LOGS: config.paths.logs,
          CFG_BACKUPS: config.paths.backups,
          CFG_AUTOSTART_NAME: config.autostartName,
          ...(instance && {
            INST_NAME: instance.name,
            INST_PORT: instance.port,
            INST_RUNTIME: instance.runtime,
            INST_CLI: instance.cli,
            INST_SERVER_LOG: instance.serverLog,
            INST_RESTART_LOG: instance.restartLog,
            INST_HEALTH_URL: instance.healthUrl,
          }),
        }));
      } else {
        print({ ...config, instance });
      }
      return 0;
    }
    case 'env': {
      const { config, instance } = load();
      prepareStagingDatabase(config, instance);
      const environment = serverEnvironment(config, instance, { local: Boolean(options.local) });
      if (format === 'sh') {
        const lines = environment.unset.map((key) => `unset ${key}`);
        for (const [key, value] of Object.entries(environment.set)) lines.push(`export ${key}=${shellQuoteSh(value)}`);
        print(lines.join('\n'));
      } else {
        print(environment);
      }
      return 0;
    }
    case 'health': {
      const { instance } = load();
      const health = await queryHealth(instance.healthUrl, Number(options.timeout) || 3000);
      print({ ...health, busy: isBusy(health.activeWork) });
      return health.up ? 0 : 3;
    }
    case 'work': {
      // For the sh scripts: describes running work; exit 4 when a restart or stop would end some.
      const { instance } = load();
      const health = await queryHealth(instance.healthUrl, 3000);
      if (!isBusy(health.activeWork)) return 0;
      const work = health.activeWork;
      const action = typeof options.action === 'string' ? options.action : 'restart';
      print(
        `Running work: ${work.turns} turn(s) being written, ${work.backgroundSessions} session(s) with background work, ` +
          `${work.backgroundTasks} background task(s).\nA ${action} ends all of it, and it cannot be resumed.`,
      );
      return 4;
    }
    case 'wait-health': {
      const { instance } = load();
      const deadline = Date.now() + (Number(options.timeout) || 60) * 1000;
      while (Date.now() < deadline) {
        const health = await queryHealth(instance.healthUrl, 2000);
        if (health.up) {
          print(health);
          return 0;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      print({ up: false, error: 'timed out' });
      return 3;
    }
    case 'port-open': {
      const { config, instance } = load();
      return (await isPortOpen(healthHost(config.listenAddress), instance.port)) ? 0 : 1;
    }
    case 'status': {
      const { config, instance } = load();
      const health = await queryHealth(instance.healthUrl, Number(options.timeout) || 3000);
      const status = buildStatus(config, instance, {
        pid: Number(options.pid) || null,
        foreignPid: Number(options['foreign-pid']) || null,
        autostart: typeof options.autostart === 'string' ? options.autostart : undefined,
        health,
      });
      print(format === 'text' ? formatStatusText(status) : status);
      return 0;
    }
    case 'deploy': {
      const { config, instance } = load();
      deploy(config, instance, {
        from: typeof options.from === 'string' ? options.from : null,
        build: Boolean(options.build),
        freshDb: Boolean(options['fresh-db']),
      });
      return 0;
    }
    case 'activate': {
      const { config, instance } = load();
      activate(config, instance);
      return 0;
    }
    case 'init-config': {
      if (fs.existsSync(configPath) && !options.force) {
        process.stderr.write(`${configPath} already exists; not overwriting it\n`);
        return 1;
      }
      const listen = typeof options.listen === 'string' ? options.listen : undefined;
      const allow = typeof options.allow === 'string'
        ? options.allow.split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean)
        : undefined;
      const text = renderConfigFromTemplate(fs.readFileSync(TEMPLATE_PATH, 'utf8'), {
        port: portOverride,
        listenAddress: listen,
        firewallAllow: allow,
        claudeCliPath: typeof options['claude-path'] === 'string' ? options['claude-path'] : undefined,
      });
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, text);
      print(`Wrote ${configPath}`);
      return 0;
    }
    case 'check-node': {
      const packageJson = JSON.parse(fs.readFileSync(path.join(CLONE_ROOT, 'package.json'), 'utf8'));
      const required = requiredNodeMajor(packageJson);
      const current = Number(process.versions.node.split('.')[0]);
      if (required !== null && current < required) {
        process.stderr.write(`Node.js ${process.versions.node} is too old: this project needs ${packageJson.engines.node}.\n`);
        return 1;
      }
      print(`Node.js ${process.versions.node} ok${required !== null ? ` (needs ${packageJson.engines.node})` : ''}`);
      return 0;
    }
    case 'spawn-detached': {
      if (typeof options.log !== 'string' || rest.length === 0) {
        process.stderr.write('usage: spawn-detached --log <file> [--cwd <dir>] -- <command> [args...]\n');
        return 2;
      }
      fs.mkdirSync(path.dirname(path.resolve(options.log)), { recursive: true });
      const fd = fs.openSync(options.log, 'a');
      // detached: its own session (setsid), so it survives the caller and its process group.
      const child = spawn(rest[0], rest.slice(1), {
        cwd: typeof options.cwd === 'string' ? options.cwd : process.cwd(),
        detached: true,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
      child.unref();
      print(String(child.pid));
      return 0;
    }
    default:
      process.stderr.write(`unknown command "${command ?? ''}"; see the top of ${fileURLToPath(import.meta.url)}\n`);
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof ConfigError ? 'config: ' : ''}${error instanceof ConfigError ? error.message : error.stack || error}\n`);
      process.exitCode = 2;
    },
  );
}
