import assert from 'node:assert/strict';
import test from 'node:test';

import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { CODEX_PREDEFINED_MODELS } from '@/modules/providers/list/codex/codex-models.provider.js';
import { CURSOR_PREDEFINED_MODELS } from '@/modules/providers/list/cursor/cursor-models.provider.js';
import { OPENCODE_PREDEFINED_MODELS } from '@/modules/providers/list/opencode/opencode-models.provider.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import type { LLMProvider, ProviderModelsDefinition } from '@/shared/types.js';

/**
 * The full curated catalogs, before OpenCode narrows its list to the upstream
 * providers a machine has connected.
 */
const CURATED_CATALOGS: Record<LLMProvider, ProviderModelsDefinition> = {
  claude: CLAUDE_PREDEFINED_MODELS,
  codex: CODEX_PREDEFINED_MODELS,
  cursor: CURSOR_PREDEFINED_MODELS,
  opencode: OPENCODE_PREDEFINED_MODELS,
};

test('capability effort levels cover every level a curated model declares', () => {
  // Custom models may declare only these levels, so a level added to a curated
  // model has to be added here too, or users could not give it to their own.
  for (const [provider, catalog] of Object.entries(CURATED_CATALOGS) as Array<[LLMProvider, ProviderModelsDefinition]>) {
    const { effortLevels, supportsEffort } = providerCapabilitiesService.getProviderCapabilities(provider);

    assert.equal(supportsEffort, effortLevels.length > 0, `${provider}: supportsEffort disagrees with effortLevels`);
    assert.equal(new Set(effortLevels).size, effortLevels.length, `${provider}: effortLevels lists a level twice`);

    const declaredLevels = new Set(
      catalog.OPTIONS.flatMap((option) => option.effort?.values.map((level) => level.value) ?? []),
    );
    const missingLevels = [...declaredLevels].filter((level) => !effortLevels.includes(level));
    assert.deepEqual(missingLevels, [], `${provider}: effortLevels misses curated levels`);
  }
});


test('side questions are supported by claude, codex and opencode, not by cursor', () => {
  // Cursor has no headless way to ask on the side; its menu then offers only
  // Queue · Stop / Send anyway.
  const expected: Record<LLMProvider, boolean> = {
    claude: true,
    codex: true,
    cursor: false,
    opencode: true,
  };
  for (const [provider, supported] of Object.entries(expected) as Array<[LLMProvider, boolean]>) {
    const capabilities = providerCapabilitiesService.getProviderCapabilities(provider) as unknown as Record<string, unknown>;
    assert.equal(capabilities.supportsSideQuestions, supported, `${provider}: supportsSideQuestions`);
  }
});

test('codex offers "Approve for me" between the default mode and accept-edits', () => {
  assert.deepEqual(
    providerCapabilitiesService.getProviderCapabilities('codex').permissionModes,
    ['default', 'approveForMe', 'acceptEdits', 'bypassPermissions'],
  );
  // Codex-only: no other runtime knows what to do with it.
  for (const provider of ['claude', 'cursor', 'opencode'] as LLMProvider[]) {
    assert.ok(!providerCapabilitiesService.getProviderCapabilities(provider).permissionModes.includes('approveForMe'), provider);
  }
});

// [local] Stage 2 of the Codex parity plan.
test('Codex offers steering only on the app-server runtime, and never Withdraw', () => {
  const original = process.env.CLOUDCLI_CODEX_RUNTIME;
  try {
    delete process.env.CLOUDCLI_CODEX_RUNTIME;
    const exec = providerCapabilitiesService.getProviderCapabilities('codex');
    assert.equal(exec.supportsSteering, false);
    assert.equal(exec.sendNowInterruptsTurn, false);
    assert.equal(exec.supportsSteerWithdrawal, false);
    assert.equal(exec.supportsMoveToBackground, false);

    process.env.CLOUDCLI_CODEX_RUNTIME = 'appserver';
    const appServer = providerCapabilitiesService.getProviderCapabilities('codex');
    assert.equal(appServer.supportsSteering, true);
    assert.equal(appServer.sendNowInterruptsTurn, true);
    assert.equal(appServer.supportsSteerWithdrawal, false, 'Codex cannot take back a steered message');
    assert.equal(appServer.supportsMoveToBackground, false);
    assert.equal(providerCapabilitiesService.listAllProviderCapabilities().find((entry) => entry.provider === 'codex')?.supportsSteering, true);

    // Claude is the same under either setting.
    const claude = providerCapabilitiesService.getProviderCapabilities('claude');
    assert.deepEqual(
      [claude.supportsSteering, claude.supportsSteerWithdrawal, claude.sendNowInterruptsTurn, claude.supportsMoveToBackground],
      [true, true, false, true],
    );
  } finally {
    if (original === undefined) {
      delete process.env.CLOUDCLI_CODEX_RUNTIME;
    } else {
      process.env.CLOUDCLI_CODEX_RUNTIME = original;
    }
  }
});

// [local] Stage 3 of the Codex parity plan.
test('Codex approval and question prompts are reported only on the app-server runtime', () => {
  const original = process.env.CLOUDCLI_CODEX_RUNTIME;
  try {
    delete process.env.CLOUDCLI_CODEX_RUNTIME;
    assert.equal(providerCapabilitiesService.getProviderCapabilities('codex').supportsPermissionRequests, false);

    process.env.CLOUDCLI_CODEX_RUNTIME = 'appserver';
    assert.equal(providerCapabilitiesService.getProviderCapabilities('codex').supportsPermissionRequests, true);
    // The others are unchanged by the setting.
    assert.equal(providerCapabilitiesService.getProviderCapabilities('claude').supportsPermissionRequests, true);
    assert.equal(providerCapabilitiesService.getProviderCapabilities('cursor').supportsPermissionRequests, false);
    assert.equal(providerCapabilitiesService.getProviderCapabilities('opencode').supportsPermissionRequests, true);
  } finally {
    if (original === undefined) {
      delete process.env.CLOUDCLI_CODEX_RUNTIME;
    } else {
      process.env.CLOUDCLI_CODEX_RUNTIME = original;
    }
  }
});
