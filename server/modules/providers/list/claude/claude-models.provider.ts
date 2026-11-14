import { readFile } from 'node:fs/promises';
import os from 'node:os';

import { query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk';

import { sessionsDb } from '@/modules/database/index.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  isPlaceholderProviderModel,
  stripAnsiSequences,
} from '@/shared/utils.js';

/**
 * Ultracode is not one of the SDK's reasoning-effort levels. Selecting it runs the turn at
 * `xhigh` effort with standing dynamic-workflow orchestration, which the Claude runtime
 * translates into the session-scoped `ultracode` setting. It is therefore only offered on
 * models this catalog already marks as xhigh-capable.
 */
export const CLAUDE_ULTRACODE_EFFORT = 'ultracode';

const ULTRACODE_EFFORT_OPTION = {
  value: CLAUDE_ULTRACODE_EFFORT,
  description: 'Highest effort plus standing workflow orchestration.',
};

export const CLAUDE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Use the recommended model for your Claude account and deployment.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'best',
      label: 'Best available',
      description: 'Use Fable when available, otherwise the latest Opus model.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'fable',
      label: 'Fable',
      description: 'Most capable Claude model for the hardest, longest-running tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Latest Sonnet model for everyday coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: 'Latest Sonnet model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Latest Opus model for complex reasoning and coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus[1m]',
      label: 'Opus (1M context)',
      description: 'Latest Opus model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fast and efficient Claude model for simple tasks.',
      // `medium` is the level Claude Code already runs Haiku at when none is sent, so
      // sessions that predate this control keep the effort they have been running with.
      // Ultracode is left out: standing workflow orchestration is not what Haiku is for.
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'opusplan',
      label: 'Opus Plan',
      description: 'Use Opus while planning, then switch to Sonnet for execution.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
  ],
  DEFAULT: 'default',
};

export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return null;
  }

  return CLAUDE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
};
type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

/** Exported for tests. */
export const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel && !isPlaceholderProviderModel(directModel)) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel && !isPlaceholderProviderModel(messageModel) ? messageModel : null;
};

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsiSequences(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    const stdoutModel = changedModel?.[1]?.trim();
    // A placeholder stdout hit must not shadow a real <model> tag further down.
    if (stdoutModel && !isPlaceholderProviderModel(stdoutModel)) {
      return stdoutModel;
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag && !isPlaceholderProviderModel(modelTag) ? modelTag : null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    // extractClaudeModelFromTextContent rejects placeholders, so a placeholder
    // part yields null here and a later part can still supply the real model.
    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const content = await readFile(jsonlPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeInitEvent;
      const model = extractClaudeEventModel(event, sessionId);
      if (model) {
        return { model };
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return null;
};

/*
 * [local] Ask the Claude Agent SDK for the same model list the Claude Code client shows in
 * /model, instead of the hard-coded alias list above. No prompt is ever sent (the prompt
 * stream never yields) and persistSession:false keeps it from writing a session .jsonl.
 * Cached for 10 minutes; falls back to the built-in list on any error or timeout.
 */
const SDK_MODELS_TTL_MS = 10 * 60 * 1000;
const SDK_MODELS_TIMEOUT_MS = 20_000;
let sdkModelsCache: { at: number; value: ProviderModelsDefinition } | null = null;
let sdkModelsInflight: Promise<ProviderModelsDefinition> | null = null;

async function querySdkModels(): Promise<ModelInfo[]> {
  let release: () => void = () => {};
  const idle = new Promise<void>((resolve) => { release = resolve; });
  // A prompt stream that never yields a message and ends once `release` is called.
  const noPrompt: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        await idle;
        return { done: true as const, value: undefined as never };
      },
    }),
  };

  const options: Record<string, unknown> = { cwd: os.tmpdir(), persistSession: false };
  const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  if (cliPath) options.pathToClaudeCodeExecutable = cliPath;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instance = query({ prompt: noPrompt as any, options: options as any });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      instance.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('supportedModels timeout')), SDK_MODELS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release();
    try { instance.close(); } catch { /* already closed */ }
  }
}

export function buildClaudeModelsDefinition(models: ModelInfo[]): ProviderModelsDefinition {
  const OPTIONS: ProviderModelOption[] = models
    .filter((model) => typeof model?.value === 'string' && model.value.trim())
    .map((model) => {
      const option: ProviderModelOption = {
        value: model.value,
        label: model.displayName || model.value,
        description: model.description || (model as { resolvedModel?: string }).resolvedModel || '',
      };
      const levels = Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels : [];
      if (levels.length > 0) {
        // Same policy as the upstream Haiku entry: default `medium`, no Ultracode.
        const resolved = (model as { resolvedModel?: string }).resolvedModel ?? model.value;
        const isHaiku = /haiku/i.test(resolved);
        const values: Array<{ value: string; description?: string }> = levels.map((value) => ({ value }));
        if (levels.includes('xhigh') && !isHaiku) values.push(ULTRACODE_EFFORT_OPTION);
        const preferred = isHaiku ? 'medium' : 'high';
        option.effort = { default: levels.includes(preferred) ? preferred : levels[levels.length - 1], values };
      }
      return option;
    });
  if (OPTIONS.length === 0) throw new Error('SDK returned no models');
  const DEFAULT = OPTIONS.some((option) => option.value === 'default') ? 'default' : OPTIONS[0].value;
  return { OPTIONS, DEFAULT };
}

async function loadClaudeModels(): Promise<ProviderModelsDefinition> {
  if (sdkModelsCache && Date.now() - sdkModelsCache.at < SDK_MODELS_TTL_MS) {
    return sdkModelsCache.value;
  }
  if (!sdkModelsInflight) {
    sdkModelsInflight = (async () => {
      try {
        const value = buildClaudeModelsDefinition(await querySdkModels());
        sdkModelsCache = { at: Date.now(), value };
        return value;
      } catch (error) {
        console.warn('[local] Claude model list from SDK failed, using built-in list:', error instanceof Error ? error.message : error);
        return sdkModelsCache?.value ?? CLAUDE_PREDEFINED_MODELS;
      } finally {
        sdkModelsInflight = null;
      }
    })();
  }
  return sdkModelsInflight;
}

export class ClaudeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return loadClaudeModels();
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(sessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
