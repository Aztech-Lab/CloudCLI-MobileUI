import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ComposerSendMenu from '@/modules/chat/composer/ComposerSendMenu';
import SteeredMessageCard from '@/modules/chat/composer/SteeredMessageCard';
import type { PendingSteer } from '@/shared/types';
import { resetUserPreferences } from '@/shared/userSettings';

/**
 * [local] Stage 2 of the Codex parity plan: Codex on the app-server runtime
 * steers like Claude, with two differences the capability matrix carries.
 * "Send now" stops the current step and starts a new turn
 * (`sendNowInterruptsTurn`), and a steered message cannot be taken back
 * (`supportsSteerWithdrawal` false), so its card has no Withdraw. Under
 * `codex exec` Codex reports no steering and the menu stays as it was.
 */

const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

const CODEX_ON_APP_SERVER = {
  provider: 'codex',
  permissionModes: ['default'],
  defaultPermissionMode: 'default',
  supportsSideQuestions: true,
  supportsSteering: true,
  supportsSteerWithdrawal: false,
  sendNowInterruptsTurn: true,
  supportsMoveToBackground: false,
};

let matrix: unknown = { success: true, data: { providers: [] } };

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: () => okJson({ success: true, data: null }),
      capabilities: () => okJson(matrix),
      sessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
      createModel: () => okJson({ success: true, data: null }),
      updateModel: () => okJson({ success: true, data: null }),
      removeModel: () => okJson({ success: true, data: null }),
    },
  },
}));

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

const openMenu = (props: { supportsSteering: boolean; sendNowInterruptsTurn?: boolean }) => {
  const onSelect = vi.fn<(choice: string) => void>();
  render(<ComposerSendMenu state="responding" hasInput supportsSideQuestions onSelect={onSelect} {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Send options' }));
  const menu = screen.getByRole('menu');
  const rows = Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
  const row = (label: string) => {
    const found = rows.find((candidate) => (candidate.textContent ?? '').startsWith(label));
    assert.ok(found, `the menu has a "${label}" row`);
    return found;
  };
  const labels = rows.map((candidate) => (candidate.textContent ?? '').replace(/(Queue|Send now|Send|Side question|Stop).*/s, '$1'));
  return { onSelect, row, labels };
};

test('Codex on the app-server gets the same rows; Send now says it stops the current step', () => {
  const { labels, row, onSelect } = openMenu({ supportsSteering: true, sendNowInterruptsTurn: true });

  assert.deepEqual(labels, ['Send', 'Send now', 'Queue', 'Side question', 'Stop']);
  assert.match(row('Send now').textContent ?? '', /Stop the current step and send it right away/);
  assert.doesNotMatch(row('Send now').textContent ?? '', /moves to the background/);
  assert.match(row('Queue').textContent ?? '', /Send when this turn ends/, 'Queue is unchanged');

  fireEvent.click(row('Send now'));
  assert.deepEqual(onSelect.mock.calls, [['sendNow']]);
});

test('Codex under exec has no steering: the menu is Queue, Side question, Stop as before', () => {
  const { labels, row } = openMenu({ supportsSteering: false, sendNowInterruptsTurn: false });

  assert.deepEqual(labels, ['Queue', 'Side question', 'Stop']);
  assert.match(row('Queue').textContent ?? '', /↵/, 'Enter still queues');
});

const steer = (fields: Partial<PendingSteer> = {}): PendingSteer => ({
  messageId: '0b5c3f8e-6d1a-4c2b-9e7f-1a2b3c4d5e6f',
  sessionKey: 'session-1',
  content: 'check the logs too',
  attachments: [],
  uploadedAttachments: [],
  status: 'accepted',
  ...fields,
});

test('a Codex steer card has no Withdraw and says when Codex reads it', () => {
  // ChatInterface passes no onWithdraw when the provider cannot withdraw.
  const { unmount } = render(<SteeredMessageCard steer={steer()} providerLabel="Codex" sendNowInterruptsTurn />);
  assert.ok(screen.getByText(/Codex reads it at its next tool call/));
  assert.equal(screen.queryByRole('button', { name: 'Withdraw' }), null);
  unmount();

  render(<SteeredMessageCard steer={steer({ urgent: true })} providerLabel="Codex" sendNowInterruptsTurn />);
  assert.ok(screen.getByText('Sent now'));
  assert.ok(screen.getByText(/Codex stops the current step and reads it/));
});

test('the Claude card keeps its wording for Send now', () => {
  render(<SteeredMessageCard steer={steer({ urgent: true })} providerLabel="Claude" />);
  assert.ok(screen.getByText(/Claude reads it right away/));
});

type ProviderState = {
  supportsSteering?: boolean;
  supportsSteerWithdrawal?: boolean;
  sendNowInterruptsTurn?: boolean;
  supportsMoveToBackground?: boolean;
  setProvider: (provider: string) => void;
};

test('the composer reads the steering flags from the matrix, all off until it loads', async () => {
  matrix = {
    success: true,
    data: {
      providers: [
        {
          provider: 'claude',
          permissionModes: ['default'],
          defaultPermissionMode: 'default',
          supportsSteering: true,
          supportsSteerWithdrawal: true,
          sendNowInterruptsTurn: false,
          supportsMoveToBackground: true,
        },
        CODEX_ON_APP_SERVER,
      ],
    },
  };
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  const { result } = renderHook(() =>
    useChatProviderState({ selectedSession: null, selectedProject: null }) as unknown as ProviderState,
  );

  await waitFor(() => assert.equal(result.current.supportsSteering, true));
  assert.equal(result.current.supportsSteerWithdrawal, true);
  assert.equal(result.current.supportsMoveToBackground, true);
  assert.equal(result.current.sendNowInterruptsTurn, false);

  act(() => { result.current.setProvider('codex'); });
  assert.equal(result.current.supportsSteering, true);
  assert.equal(result.current.supportsSteerWithdrawal, false);
  assert.equal(result.current.supportsMoveToBackground, false);
  assert.equal(result.current.sendNowInterruptsTurn, true);
});
