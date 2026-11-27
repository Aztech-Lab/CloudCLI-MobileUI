import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  codexAppServer,
  type CodexAppServerModel,
} from '@/modules/providers/list/codex/codex-app-server.client.js';
import {
  buildCodexModelsDefinition,
  CODEX_PREDEFINED_MODELS,
  CodexProviderModels,
  codexModelsLoader,
  resetCodexModelsCache,
  withConfiguredCodexModel,
} from '@/modules/providers/list/codex/codex-models.provider.js';

/**
 * [local] A real `model/list` reply from Codex 0.169 signed in to ChatGPT,
 * fetched with `includeHidden: true` so it also holds the two hidden models.
 * Only slugs, names, descriptions, flags and effort levels were kept.
 */
const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-model-list.json');
const loadFixture = async (): Promise<CodexAppServerModel[]> =>
  (JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as { data: CodexAppServerModel[] }).data;

const original = { ...codexModelsLoader };
const restoreLoader = () => {
  Object.assign(codexModelsLoader, original);
  resetCodexModelsCache();
};

/** Silences the expected `[local] ... failed` warning and returns what was logged. */
const captureWarnings = async (run: () => Promise<void>): Promise<string[]> => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    await run();
  } finally {
    console.warn = warn;
  }
  return warnings;
};

test('maps the recorded model/list reply to picker options with Codex effort levels', async () => {
  const catalog = buildCodexModelsDefinition(await loadFixture());

  assert.deepEqual(catalog.OPTIONS.map((option) => option.value), [
    'gpt-6.2-sol',
    'gpt-6.2-astra',
    'gpt-6.1-terra',
    'gpt-6.1-sol',
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
  ]);
  assert.equal(catalog.DEFAULT, 'gpt-6.2-sol', 'the model Codex marks isDefault');

  const sol = catalog.OPTIONS[0];
  assert.equal(sol.label, 'GPT-6.2-Sol');
  assert.equal(sol.description, 'Fast, go-to model for coding and everyday work.');
  assert.equal(sol.effort?.default, 'medium');
  assert.deepEqual(sol.effort?.values.map((effort) => effort.value), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(sol.effort?.values[5].description, 'Maximum reasoning with automatic task delegation');

  const astra = catalog.OPTIONS.find((option) => option.value === 'gpt-6.2-astra');
  assert.equal(astra?.effort?.default, 'low');

  const luna = catalog.OPTIONS.find((option) => option.value === 'gpt-6-luna');
  assert.deepEqual(luna?.effort?.values.map((effort) => effort.value), ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('leaves out models Codex hides from pickers', async () => {
  const fixture = await loadFixture();
  assert.ok(fixture.some((model) => model.hidden), 'fixture holds hidden models');
  const values = buildCodexModelsDefinition(fixture).OPTIONS.map((option) => option.value);
  assert.ok(!values.includes('gpt-reserve'));
  assert.ok(!values.includes('codex-auto-review'));
});

test('falls back to the first model, a valid effort default and no effort control when Codex omits them', () => {
  const catalog = buildCodexModelsDefinition([
    { model: 'a', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'ultra' },
    { id: 'b', displayName: 'B' },
    { model: '  ' },
  ]);
  assert.equal(catalog.DEFAULT, 'a');
  assert.deepEqual(catalog.OPTIONS.map((option) => [option.value, option.label]), [['a', 'a'], ['b', 'B']]);
  assert.equal(catalog.OPTIONS[0].effort?.default, 'low');
  assert.equal(catalog.OPTIONS[1].effort, undefined);
  assert.throws(() => buildCodexModelsDefinition([{ model: 'x', hidden: true }]), /no visible models/);
});

test('keeps the model from config.toml selectable when Codex does not list it', () => {
  const kept = withConfiguredCodexModel(CODEX_PREDEFINED_MODELS, 'my-local-model');
  assert.equal(kept.OPTIONS.at(-1)?.value, 'my-local-model');
  assert.equal(kept.DEFAULT, CODEX_PREDEFINED_MODELS.DEFAULT);
  assert.equal(withConfiguredCodexModel(CODEX_PREDEFINED_MODELS, 'gpt-6-sol'), CODEX_PREDEFINED_MODELS);
  assert.equal(withConfiguredCodexModel(CODEX_PREDEFINED_MODELS, null), CODEX_PREDEFINED_MODELS);
});

test('caches the live list and serves a stale one while it refreshes', { concurrency: false }, async (t) => {
  t.after(restoreLoader);
  resetCodexModelsCache();
  const fixture = await loadFixture();
  let calls = 0;
  codexModelsLoader.readConfiguredModel = async () => 'gpt-6.1-sol';
  codexModelsLoader.listModels = async () => {
    calls += 1;
    return calls === 1 ? fixture : [{ model: 'refreshed', isDefault: true }];
  };
  const provider = new CodexProviderModels();

  const first = await provider.getSupportedModels();
  const second = await provider.getSupportedModels();
  assert.equal(calls, 1, 'second call is served from the cache');
  assert.equal(first.DEFAULT, 'gpt-6.2-sol');
  assert.deepEqual(second, first);
  assert.deepEqual(await provider.getCurrentActiveModel(), { model: 'gpt-6.1-sol' });

  codexModelsLoader.ttlMs = 0;
  const stale = await provider.getSupportedModels();
  assert.equal(stale.DEFAULT, 'gpt-6.2-sol', 'expired cache is returned at once');
  await new Promise((resolve) => { setImmediate(resolve); });
  codexModelsLoader.ttlMs = original.ttlMs;
  const refreshed = await provider.getSupportedModels();
  assert.equal(calls, 2);
  assert.equal(refreshed.DEFAULT, 'refreshed');
  assert.deepEqual(refreshed.OPTIONS.map((option) => option.value), ['refreshed', 'gpt-6.1-sol']);
});

test('falls back to the built-in list on timeout, keeps the config model, and retries later', { concurrency: false }, async (t) => {
  t.after(restoreLoader);
  resetCodexModelsCache();
  let aborted = false;
  let calls = 0;
  codexModelsLoader.timeoutMs = 20;
  codexModelsLoader.readConfiguredModel = async () => 'my-local-model';
  codexModelsLoader.listModels = (signal) => {
    calls += 1;
    signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  };
  const provider = new CodexProviderModels();

  let catalog: Awaited<ReturnType<CodexProviderModels['getSupportedModels']>> | undefined;
  const warnings = await captureWarnings(async () => {
    catalog = await provider.getSupportedModels();
    await provider.getSupportedModels();
  });
  assert.deepEqual(catalog?.OPTIONS.slice(0, -1), CODEX_PREDEFINED_MODELS.OPTIONS);
  assert.equal(catalog?.OPTIONS.at(-1)?.value, 'my-local-model');
  assert.ok(aborted, 'the app-server request is stopped on timeout');
  assert.equal(calls, 1, 'a failure is not retried before retryAfterFailureMs');
  assert.match(warnings[0] ?? '', /^\[local\] Codex model list .*timeout/);
});

test('falls back to the built-in list when model/list fails', { concurrency: false }, async (t) => {
  t.after(restoreLoader);
  resetCodexModelsCache();
  codexModelsLoader.readConfiguredModel = async () => null;
  codexModelsLoader.listModels = async () => { throw new Error('Codex app-server exited'); };
  const warnings = await captureWarnings(async () => {
    assert.equal(await new CodexProviderModels().getSupportedModels(), CODEX_PREDEFINED_MODELS);
  });
  assert.match(warnings[0] ?? '', /\[local\].*Codex app-server exited/);
});

test('listModels asks a short-lived app-server for visible models and follows the cursor', { concurrency: false }, async () => {
  const fixture = await loadFixture();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-model-list-'));
  const log = path.join(dir, 'received.jsonl');
  const script = path.join(dir, 'fake-app-server.cjs');
  const pages = [fixture.slice(0, 5), fixture.slice(5)];
  await writeFile(script, `
const fs = require('node:fs');
const readline = require('node:readline');
const pages = ${JSON.stringify(pages)};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
  if (message.id === undefined) return;
  let result = {};
  if (message.method === 'model/list') {
    const page = message.params.cursor === 'page-2' ? 1 : 0;
    result = { data: pages[page], nextCursor: page === 0 ? 'page-2' : null };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`, 'utf8');
  const appServer = codexAppServer as unknown as { resolveCommand: () => { command: string; args: string[]; env: NodeJS.ProcessEnv } };
  const originalLauncher = appServer.resolveCommand;
  appServer.resolveCommand = () => ({ command: process.execPath, args: [script], env: process.env });
  try {
    const models = await codexAppServer.listModels();
    assert.equal(models.length, fixture.length);
    const received = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(received.map((line) => line.method), ['initialize', 'initialized', 'model/list', 'model/list']);
    assert.deepEqual(received[2].params, { includeHidden: false });
    assert.deepEqual(received[3].params, { includeHidden: false, cursor: 'page-2' });
    assert.ok(!received.some((line) => /^(thread|turn)\//.test(line.method)), 'starts no thread or turn');
  } finally {
    appServer.resolveCommand = originalLauncher;
    await rm(dir, { recursive: true, force: true });
  }
});
