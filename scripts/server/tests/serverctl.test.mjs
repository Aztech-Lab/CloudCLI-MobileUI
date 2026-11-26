// Tests for the config handling in scripts/server/lib/serverctl.mjs.
// Run: node --test scripts/server/tests/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  ConfigError,
  buildStatus,
  defaultConfigPath,
  expandValue,
  isBusy,
  isValidIpv4Cidr,
  parseJsonc,
  renderConfigFromTemplate,
  requiredNodeMajor,
  resolveConfig,
  resolveInstance,
  serverEnvironment,
  stripJsonc,
} from '../lib/serverctl.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(here, '..', 'config.template.jsonc');
const helperPath = path.join(here, '..', 'lib', 'serverctl.mjs');
const clone = path.resolve(os.tmpdir(), 'clone');

test('JSONC: comments and trailing commas are removed, strings are kept', () => {
  const text = `{
    // line comment
    "a": "http://x//y", /* block */ "b": [1, 2,],
    "c": "quote \\" // not a comment",
  }`;
  assert.deepEqual(JSON.parse(stripJsonc(text)), { a: 'http://x//y', b: [1, 2], c: 'quote " // not a comment' });
});

test('JSONC: a BOM is tolerated and errors name the file', () => {
  assert.deepEqual(parseJsonc('\uFEFF{"port": 1}'), { port: 1 });
  assert.throws(() => parseJsonc('{port: 1}', 'my.json'), (error) => error instanceof ConfigError && /my\.json/.test(error.message));
});

test('the committed template parses and has safe defaults', () => {
  const config = resolveConfig(parseJsonc(fs.readFileSync(templatePath, 'utf8')), { configPath: 'x', cloneRoot: clone });
  assert.equal(config.port, 3001);
  assert.equal(config.listenAddress, '127.0.0.1');
  assert.deepEqual(config.firewallAllow, []);
  assert.equal(config.stagingPort, null);
  assert.equal(config.paths.runtime, path.join(clone, '_server', 'runtime'));
  assert.equal(config.paths.logs, path.join(clone, '_server', 'logs'));
  assert.equal(config.autostartName, 'CloudCLI-MobileUI');
  assert.equal(config.backupsToKeep, 3);
  // An empty CLAUDE_CLI_PATH means "do not set it".
  assert.equal(config.env.CLAUDE_CLI_PATH, null);
});

test('paths: relative ones resolve against the clone, absolute ones are kept, ~ and ${VAR} expand', () => {
  const absolute = path.resolve(os.tmpdir(), 'ops', 'logs');
  const config = resolveConfig(
    { paths: { runtime: '../runtime', logs: absolute, backups: '~/old', staging: '${OPS}/staging' } },
    { cloneRoot: clone, env: { OPS: path.resolve(os.tmpdir(), 'ops') }, home: path.resolve(os.tmpdir(), 'home'), windows: false },
  );
  assert.equal(config.paths.runtime, path.resolve(clone, '..', 'runtime'));
  assert.equal(config.paths.logs, absolute);
  assert.equal(config.paths.backups, path.resolve(os.tmpdir(), 'home', 'old'));
  assert.equal(config.paths.staging, path.resolve(os.tmpdir(), 'ops', 'staging'));
});

test('expandValue: %VAR% only on Windows, case-insensitive there', () => {
  assert.equal(expandValue('%UserProfile%\\x', { USERPROFILE: 'C:\\Users\\u' }, 'h', true), 'C:\\Users\\u\\x');
  assert.equal(expandValue('%USERPROFILE%', { USERPROFILE: 'u' }, 'h', false), '%USERPROFILE%');
  assert.equal(expandValue('%MISSING%', {}, 'h', true), '%MISSING%');
});

test('validation rejects bad ports, networks and names', () => {
  const bad = [
    { port: 0 },
    { port: 'abc' },
    { port: 3001, stagingPort: 3001 },
    { firewallAllow: ['192.168.1.0/33'] },
    { firewallAllow: 'not-a-list' },
    { autostartName: 'has space' },
    { env: { 'BAD-NAME': 'x' } },
    { env: { X: { nested: true } } },
  ];
  for (const raw of bad) {
    assert.throws(() => resolveConfig(raw, { cloneRoot: clone }), ConfigError, JSON.stringify(raw));
  }
});

test('isValidIpv4Cidr', () => {
  assert.ok(isValidIpv4Cidr('10.0.0.0/8'));
  assert.ok(isValidIpv4Cidr('192.168.1.7'));
  assert.ok(!isValidIpv4Cidr('256.1.1.1/24'));
  assert.ok(!isValidIpv4Cidr('fe80::/10'));
});

test('instances: live and staging get their own folders, logs and ports', () => {
  const config = resolveConfig({ port: 4000, stagingPort: 4001, listenAddress: '0.0.0.0' }, { cloneRoot: clone });
  const live = resolveInstance(config, 'live');
  const staging = resolveInstance(config, 'staging');
  assert.equal(live.port, 4000);
  assert.equal(live.next, `${config.paths.runtime}.next`);
  assert.equal(live.serverLog, path.join(config.paths.logs, 'cloudcli.log'));
  assert.equal(live.healthUrl, 'http://127.0.0.1:4000/health');
  assert.equal(staging.port, 4001);
  assert.equal(staging.runtime, path.join(config.paths.staging, 'runtime'));
  assert.equal(staging.db, path.join(config.paths.staging, 'auth.db'));
  assert.equal(staging.serverLog, path.join(config.paths.logs, 'staging.log'));
  assert.equal(resolveInstance(config, 'live', { port: 4999 }).port, 4999);

  const noStaging = resolveConfig({}, { cloneRoot: clone });
  assert.throws(() => resolveInstance(noStaging, 'staging'), ConfigError);
});

test('health uses the listen address when it is a specific one', () => {
  const config = resolveConfig({ listenAddress: '10.1.2.3' }, { cloneRoot: clone });
  assert.equal(resolveInstance(config).healthUrl, 'http://10.1.2.3:3001/health');
});

test('server environment: live never inherits the test portal settings or platform mode', () => {
  const config = resolveConfig(
    {
      port: 4000,
      stagingPort: 4001,
      listenAddress: '0.0.0.0',
      env: { CLAUDE_CLI_PATH: '/bin/claude', DROP_ME: '', VITE_IS_PLATFORM: 'true' },
      stagingEnv: { CLOUDCLI_CODEX_RUNTIME: 'appserver' },
    },
    { cloneRoot: clone, configPath: path.join(clone, '_server', 'config.json') },
  );
  const live = serverEnvironment(config, resolveInstance(config, 'live'));
  assert.equal(live.set.HOST, '0.0.0.0');
  assert.equal(live.set.SERVER_PORT, '4000');
  assert.equal(live.set.CLAUDE_CLI_PATH, '/bin/claude');
  assert.equal(live.set.CLOUDCLI_SERVER_CONTROL_INSTANCE, 'live');
  assert.equal(live.set.CLOUDCLI_SERVER_CONTROL_DIR, path.join(clone, 'scripts', 'server'));
  assert.equal(live.set.CLOUDCLI_SERVER_CONTROL_CONFIG, path.join(clone, '_server', 'config.json'));
  assert.ok(!('VITE_IS_PLATFORM' in live.set));
  for (const key of ['VITE_IS_PLATFORM', 'DATABASE_PATH', 'CLOUDCLI_CODEX_RUNTIME', 'DROP_ME']) {
    assert.ok(live.unset.includes(key), key);
  }

  const staging = serverEnvironment(config, resolveInstance(config, 'staging'), { local: true });
  assert.equal(staging.set.HOST, '127.0.0.1');
  assert.equal(staging.set.SERVER_PORT, '4001');
  assert.equal(staging.set.CLOUDCLI_CODEX_RUNTIME, 'appserver');
  assert.equal(staging.set.DATABASE_PATH, path.join(config.paths.staging, 'auth.db'));
  assert.ok(!staging.unset.includes('DATABASE_PATH'));
  assert.ok(staging.unset.includes('VITE_IS_PLATFORM'));
});

test('a DATABASE_PATH in env is used by the live server', () => {
  const config = resolveConfig({ env: { DATABASE_PATH: '/data/auth.db' } }, { cloneRoot: clone });
  const live = serverEnvironment(config, resolveInstance(config));
  assert.equal(live.set.DATABASE_PATH, '/data/auth.db');
  assert.ok(!live.unset.includes('DATABASE_PATH'));
});

test('setup answers fill the template and keep its comments', () => {
  const text = renderConfigFromTemplate(fs.readFileSync(templatePath, 'utf8'), {
    port: 3123,
    listenAddress: '0.0.0.0',
    firewallAllow: ['192.0.2.0/24'],
    claudeCliPath: 'C:\\Tools\\claude.exe',
  });
  assert.match(text, /\/\/ Port of the web UI\./);
  const config = resolveConfig(parseJsonc(text), { cloneRoot: clone, windows: false });
  assert.equal(config.port, 3123);
  assert.equal(config.listenAddress, '0.0.0.0');
  assert.deepEqual(config.firewallAllow, ['192.0.2.0/24']);
  assert.equal(config.env.CLAUDE_CLI_PATH, 'C:\\Tools\\claude.exe');
});

test('setup answers also work on a CRLF checkout of the template', () => {
  const crlf = fs.readFileSync(templatePath, 'utf8').replace(/\r?\n/g, '\r\n');
  const config = resolveConfig(parseJsonc(renderConfigFromTemplate(crlf, { port: 3200 })), { cloneRoot: clone });
  assert.equal(config.port, 3200);
});

test('status combines the process, health and build information', () => {
  const config = resolveConfig({}, { cloneRoot: clone });
  const instance = resolveInstance(config);
  const health = { up: true, version: '1.2.3', activeWork: { turns: 1, backgroundSessions: 0, backgroundTasks: 0 } };
  const status = buildStatus(config, instance, { pid: 42, autostart: 'on', health });
  assert.equal(status.running, true);
  assert.equal(status.pid, 42);
  assert.equal(status.version, '1.2.3');
  assert.deepEqual(status.activeWork, health.activeWork);
  assert.equal(status.autostart, 'on');
  assert.equal(status.build, null);
  assert.ok(isBusy(status.activeWork));
  assert.ok(!isBusy({ turns: 0, backgroundSessions: 0, backgroundTasks: 0 }));

  const foreign = buildStatus(config, instance, { foreignPid: 7, health: { up: true, version: 'x', activeWork: null } });
  assert.equal(foreign.running, false);
  assert.equal(foreign.version, 'x');
});

test('requiredNodeMajor reads engines.node', () => {
  assert.equal(requiredNodeMajor({ engines: { node: '>=22' } }), 22);
  assert.equal(requiredNodeMajor({ engines: { node: '>=20.19.0' } }), 20);
  assert.equal(requiredNodeMajor({}), null);
});

test('defaultConfigPath honours CLOUDCLI_SERVER_CONFIG', () => {
  assert.equal(defaultConfigPath({}, clone), path.join(clone, '_server', 'config.json'));
  const custom = path.resolve(os.tmpdir(), 'c.json');
  assert.equal(defaultConfigPath({ CLOUDCLI_SERVER_CONFIG: custom }, clone), custom);
});

test('command line: init-config, config --format sh and a missing config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serverctl-test-'));
  try {
    const configPath = path.join(dir, 'config.json');
    const run = (...args) => spawnSync(process.execPath, [helperPath, ...args], { encoding: 'utf8' });

    const missing = run('config', '--config', configPath);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Run scripts\/server\/setup/);

    assert.equal(run('init-config', '--config', configPath, '--port', '3555', '--allow', '192.0.2.0/24, 198.51.100.0/24', '--listen', '0.0.0.0').status, 0);
    assert.equal(run('init-config', '--config', configPath, '--port', '3556').status, 1, 'never overwrites');

    const sh = run('config', '--config', configPath, '--instance', 'live', '--format', 'sh');
    assert.equal(sh.status, 0, sh.stderr);
    assert.match(sh.stdout, /^CFG_PORT='3555'$/m);
    assert.match(sh.stdout, /^CFG_ALLOW='192\.0\.2\.0\/24 198\.51\.100\.0\/24'$/m);
    assert.match(sh.stdout, /^INST_PORT='3555'$/m);

    const env = run('env', '--config', configPath, '--instance', 'live', '--format', 'sh');
    assert.match(env.stdout, /^unset VITE_IS_PLATFORM$/m);
    assert.match(env.stdout, /^export SERVER_PORT='3555'$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
