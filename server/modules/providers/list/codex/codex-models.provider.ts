import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import {
  codexAppServer,
  type CodexAppServerModel,
} from '@/modules/providers/list/codex/codex-app-server.client.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

/** Builds one effort control; arrays are built per call so options never share them. */
const effortControl = (
  defaultEffort: string,
  levels: readonly string[],
): NonNullable<ProviderModelOption['effort']> => ({
  default: defaultEffort,
  values: levels.map((value) => ({ value })),
});

const EFFORTS_TO_ULTRA = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const EFFORTS_TO_MAX = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Curated Codex catalog shipped as immutable CloudCLI defaults. [local] Since
 * the picker asks Codex for the account's live list (codexModelsLoader below),
 * this is only the fallback for when that fails or times out. It mirrors the
 * picker-visible models of the bundled catalog, in its order, with its names,
 * descriptions and effort levels.
 */
export const CODEX_PREDEFINED_MODELS: ProviderModelsDefinition = {
  // Chats run the bundled `@openai/codex` CLI (or the user's own Codex when it
  // is newer), which takes model metadata from its own bundled catalog
  // (`codex debug models --bundled`), from a slug-prefix match against that
  // catalog, or (signed in to ChatGPT) from OpenAI's remote catalog; anything
  // else runs on fallback metadata. So every entry must be one of the bundled
  // catalog's exact slugs, which codex-models.test.ts checks.
  OPTIONS: [
    {
      value: 'gpt-6.1-sol',
      label: 'GPT-6.1-Sol',
      description: 'Latest workhorse model for coding and everyday work.',
      effort: effortControl('low', EFFORTS_TO_ULTRA),
    },
    {
      value: 'gpt-6-astra',
      label: 'GPT-6-Astra',
      description: 'Frontier intelligence for the most demanding work.',
      effort: effortControl('low', EFFORTS_TO_ULTRA),
    },
    {
      value: 'gpt-6-sol',
      label: 'GPT-6-Sol',
      description: 'Previous generation workhorse model.',
      effort: effortControl('medium', EFFORTS_TO_ULTRA),
    },
    {
      value: 'gpt-6-luna',
      label: 'GPT-6-Luna',
      description: 'Fast and affordable model for easier tasks.',
      effort: effortControl('medium', EFFORTS_TO_MAX),
    },
    {
      value: 'gpt-5.6-sol',
      label: 'GPT-5.6-Sol',
      description: 'Older generation workhorse model.',
      effort: effortControl('low', EFFORTS_TO_ULTRA),
    },
    {
      value: 'gpt-6.1-terra',
      label: 'GPT-6.1 Terra',
      description: 'Balanced agentic coding model for everyday work.',
      effort: effortControl('low', EFFORTS_TO_ULTRA),
    },
    {
      value: 'gpt-5.6-terra',
      label: 'GPT-5.6-Terra',
      description: 'Older balanced model for straightforward work.',
      effort: effortControl('medium', EFFORTS_TO_ULTRA),
    },
    {
      value: 'gpt-5.6-luna',
      label: 'GPT-5.6-Luna',
      description: 'Older fast and efficient model.',
      effort: effortControl('medium', EFFORTS_TO_MAX),
    },
    {
      value: 'gpt-5.5',
      label: 'GPT-5.5',
      description: 'Legacy coding model.',
      effort: effortControl('medium', ['low', 'medium', 'high', 'xhigh']),
    },
  ],
  DEFAULT: 'gpt-5.6-sol',
};

const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

/** The top-level `model` of ~/.codex/config.toml, or null when unset or unreadable. */
async function readConfiguredCodexModel(): Promise<string | null> {
  try {
    const raw = await readFile(CODEX_CONFIG_PATH, 'utf8');
    return readOptionalString(readObjectRecord(TOML.parse(raw))?.model) ?? null;
  } catch {
    return null;
  }
}

/**
 * [local] Turns the app-server's `model/list` reply into CloudCLI's catalog.
 * `value` is the slug Codex accepts, label and description are Codex's own,
 * and the effort control lists exactly the levels Codex reports for that
 * model, defaulting to the one Codex would use. Models Codex hides from
 * pickers are dropped even if one slips through `includeHidden: false`.
 */
export function buildCodexModelsDefinition(models: CodexAppServerModel[]): ProviderModelsDefinition {
  const OPTIONS: ProviderModelOption[] = [];
  let DEFAULT: string | null = null;
  for (const model of models) {
    if (!model || model.hidden === true) continue;
    const value = readOptionalString(model.model) ?? readOptionalString(model.id);
    if (!value || OPTIONS.some((option) => option.value === value)) continue;

    const option: ProviderModelOption = {
      value,
      label: readOptionalString(model.displayName) ?? value,
      description: readOptionalString(model.description) ?? '',
    };
    const values: Array<{ value: string; description?: string }> = [];
    const efforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
    for (const entry of efforts) {
      const effort = readOptionalString(entry?.reasoningEffort);
      if (!effort || values.some((existing) => existing.value === effort)) continue;
      const description = readOptionalString(entry?.description);
      values.push(description ? { value: effort, description } : { value: effort });
    }
    if (values.length > 0) {
      const preferred = readOptionalString(model.defaultReasoningEffort);
      option.effort = {
        default: preferred && values.some((effort) => effort.value === preferred) ? preferred : values[0].value,
        values,
      };
    }
    OPTIONS.push(option);
    if (model.isDefault === true && DEFAULT === null) DEFAULT = value;
  }
  if (OPTIONS.length === 0) throw new Error('model/list returned no visible models');
  return { OPTIONS, DEFAULT: DEFAULT ?? OPTIONS[0].value };
}

/**
 * [local] Keeps the model ~/.codex/config.toml names selectable when the
 * catalog does not list it (an older model, a custom provider's model), so
 * the picker never loses the model new chats actually run on.
 */
export function withConfiguredCodexModel(
  catalog: ProviderModelsDefinition,
  configuredModel: string | null,
): ProviderModelsDefinition {
  const model = configuredModel?.trim();
  if (!model || catalog.OPTIONS.some((option) => option.value === model)) {
    return catalog;
  }
  return {
    ...catalog,
    OPTIONS: [
      ...catalog.OPTIONS,
      { value: model, label: model, description: 'Model set in ~/.codex/config.toml.' },
    ],
  };
}

/*
 * [local] The picker asks Codex itself (`model/list`, see
 * codexAppServer.listModels) instead of showing only the hard-coded list
 * above, the way the Claude picker asks the Claude Agent SDK
 * (claude-models.provider.ts). Cached for 10 minutes; an expired cache is
 * served at once while a refresh runs behind it, so only the very first
 * request waits, and never longer than the timeout. On an error or timeout
 * the built-in list (or the last live list) is used and the next attempt is
 * made a minute later. Tunables and sources sit on one object so tests can
 * replace them.
 */
export const codexModelsLoader = {
  ttlMs: 10 * 60 * 1000,
  timeoutMs: 6_000,
  retryAfterFailureMs: 60 * 1000,
  listModels: (signal: AbortSignal): Promise<CodexAppServerModel[]> => codexAppServer.listModels({ signal }),
  readConfiguredModel: readConfiguredCodexModel,
};

let liveModelsCache: { at: number; value: ProviderModelsDefinition; failed: boolean } | null = null;
let liveModelsInflight: Promise<ProviderModelsDefinition> | null = null;

/** [local] Forgets the cached live list. For tests. */
export function resetCodexModelsCache(): void {
  liveModelsCache = null;
  liveModelsInflight = null;
}

async function queryLiveCodexModels(): Promise<ProviderModelsDefinition> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return buildCodexModelsDefinition(await Promise.race([
      codexModelsLoader.listModels(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`model/list timeout after ${codexModelsLoader.timeoutMs}ms`)),
          codexModelsLoader.timeoutMs,
        );
      }),
    ]));
  } finally {
    clearTimeout(timer);
    // Stops the app-server child when the timeout won the race.
    controller.abort();
  }
}

function refreshLiveCodexModels(): Promise<ProviderModelsDefinition> {
  if (!liveModelsInflight) {
    liveModelsInflight = (async () => {
      try {
        const value = await queryLiveCodexModels();
        liveModelsCache = { at: Date.now(), value, failed: false };
        return value;
      } catch (error) {
        console.warn(
          '[local] Codex model list from model/list failed, using built-in list:',
          error instanceof Error ? error.message : error,
        );
        const previous = liveModelsCache && !liveModelsCache.failed ? liveModelsCache.value : null;
        const value = previous ?? CODEX_PREDEFINED_MODELS;
        // Marked failed so the next attempt comes after retryAfterFailureMs, not ttlMs.
        liveModelsCache = { at: Date.now(), value, failed: true };
        return value;
      } finally {
        liveModelsInflight = null;
      }
    })();
  }
  return liveModelsInflight;
}

async function loadCodexModels(): Promise<ProviderModelsDefinition> {
  if (!liveModelsCache) {
    return refreshLiveCodexModels();
  }
  const maxAge = liveModelsCache.failed ? codexModelsLoader.retryAfterFailureMs : codexModelsLoader.ttlMs;
  if (Date.now() - liveModelsCache.at >= maxAge) {
    void refreshLiveCodexModels();
  }
  return liveModelsCache.value;
}

/** Provider registry model adapter for the Codex account's models and active config. */
export class CodexProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const [catalog, configuredModel] = await Promise.all([
      loadCodexModels(),
      codexModelsLoader.readConfiguredModel(),
    ]);
    return withConfiguredCodexModel(catalog, configuredModel);
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    const model = await codexModelsLoader.readConfiguredModel();
    if (model) {
      return { model };
    }
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
