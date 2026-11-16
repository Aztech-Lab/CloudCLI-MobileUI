import assert from 'node:assert/strict';

import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import BackgroundSendDialog from '@/modules/chat/composer/BackgroundSendDialog';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import ComposerSendMenu from '@/modules/chat/composer/ComposerSendMenu';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { SessionActivity } from '@/shared/types';

/**
 * [local] Over background work, the send menu's last row says what a send
 * does. When the message joins the session's running process
 * (`adoptsBackground`), it is a plain Send — not red, and Enter does it too.
 * Otherwise (no capability, an edit, a slash command) it stays the red "Send
 * anyway", which stops the work.
 */

type ComposerProps = ComponentProps<typeof ChatComposer>;

const BACKGROUND: SessionActivity = { statusText: null, canInterrupt: false, startedAt: 1, background: true, tasks: [] };

const open = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Send options' }));
  return screen.getByRole('menu');
};
const items = (menu: HTMLElement) => Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
const lastRow = (menu: HTMLElement) => {
  const rows = items(menu);
  return rows[rows.length - 1];
};
const looksDestructive = (row: HTMLElement) =>
  [row, ...Array.from(row.querySelectorAll<HTMLElement>('*'))]
    .some((element) => /destructive|red-/.test(element.getAttribute('class') ?? ''));
const hintOf = (row: HTMLElement) => row.querySelector('kbd')?.textContent ?? null;

afterEach(() => {
  vi.restoreAllMocks();
});

test('over background work, a send that joins the process is a plain Send with the Enter hint', () => {
  const onSelect = vi.fn();
  render(<ComposerSendMenu state="background" hasInput supportsSideQuestions adoptsBackground onSelect={onSelect} />);
  const menu = open();

  const send = lastRow(menu);
  assert.match(send.textContent ?? '', /^Send/);
  assert.doesNotMatch(send.textContent ?? '', /Send anyway/);
  assert.match(send.textContent ?? '', /Send now; the background work keeps running/);
  assert.doesNotMatch(send.textContent ?? '', /stops the background work/);
  assert.ok(!looksDestructive(send), 'nothing is stopped, so it is not drawn as destructive');
  assert.equal(hintOf(send), '↵');
  // Queue still waits for the work, and has no key there.
  assert.match(items(menu)[0].textContent ?? '', /Send when the background work ends/);
  assert.equal(hintOf(items(menu)[0]), null);

  fireEvent.click(send);
  assert.deepEqual(onSelect.mock.calls, [['send']]);
});

test('the Send hint follows the send-with-Ctrl+Enter setting', () => {
  render(<ComposerSendMenu state="background" hasInput adoptsBackground sendByCtrlEnter onSelect={() => undefined} />);
  const send = lastRow(open());

  assert.match(hintOf(send) ?? '', /^(Ctrl|⌘)/);
});

test('over background work, a send that stops the work stays the red Send anyway', () => {
  const onSelect = vi.fn();
  render(<ComposerSendMenu state="background" hasInput adoptsBackground={false} onSelect={onSelect} />);
  const sendAnyway = lastRow(open());

  assert.match(sendAnyway.textContent ?? '', /^Send anyway/);
  assert.match(sendAnyway.textContent ?? '', /Send now; this stops the background work/);
  assert.ok(looksDestructive(sendAnyway));
  assert.equal(hintOf(sendAnyway), null);

  fireEvent.click(sendAnyway);
  assert.deepEqual(onSelect.mock.calls, [['send']]);
});

test('while a turn is written the last row stays Stop, whatever a send would do', () => {
  render(<ComposerSendMenu state="responding" hasInput adoptsBackground onSelect={() => undefined} />);
  const stop = lastRow(open());

  assert.match(stop.textContent ?? '', /^Stop/);
  assert.ok(looksDestructive(stop));
  assert.equal(hintOf(stop), 'esc');
});

const composerProps = (overrides: Partial<ComposerProps>): ComposerProps => ({
  pendingPermissionRequests: [],
  handlePermissionDecision: () => undefined,
  handleGrantToolPermission: () => ({ success: true }),
  activity: BACKGROUND,
  isLoading: false,
  onAbortSession: () => undefined,
  permissionMode: 'default',
  availablePermissionModes: ['default'],
  onSelectPermissionMode: () => undefined,
  providerLabel: 'Claude',
  effort: 'medium',
  availableEffortOptions: [],
  onSelectEffort: () => undefined,
  model: 'test-model',
  availableModelOptions: [],
  onSelectModel: () => undefined,
  modelsLoading: false,
  tokenBudget: null,
  onShowTokenUsage: () => undefined,
  slashCommandsCount: 0,
  onToggleCommandMenu: () => undefined,
  hasInput: true,
  onClearInput: () => undefined,
  onSubmit: () => undefined,
  isDragActive: false,
  queuedDraft: null,
  backgroundSendPrompt: null,
  onResolveBackgroundSendPrompt: () => undefined,
  isEditingSentMessage: false,
  onCancelEditMessage: () => undefined,
  scheduledMessages: [],
  onScheduleMessage: () => undefined,
  onCancelScheduledMessage: () => undefined,
  onEditQueuedDraft: () => undefined,
  onDeleteQueuedDraft: () => undefined,
  attachedFiles: [],
  onRemoveAttachment: () => undefined,
  fileErrors: new Map(),
  showFileDropdown: false,
  filteredFiles: [],
  selectedFileIndex: -1,
  onSelectFile: () => undefined,
  filteredCommands: [],
  selectedCommandIndex: -1,
  onCommandSelect: () => undefined,
  onCloseCommandMenu: () => undefined,
  isCommandMenuOpen: false,
  frequentCommands: [],
  getRootProps: () => ({}),
  getInputProps: () => ({}),
  openAttachmentPicker: () => undefined,
  inputHighlightRef: createRef<HTMLDivElement>() as ComposerProps['inputHighlightRef'],
  renderInputWithMentions: (text) => text,
  textareaRef: createRef<HTMLTextAreaElement>() as ComposerProps['textareaRef'],
  input: 'hello',
  onInputChange: () => undefined,
  onTextareaClick: () => undefined,
  onTextareaKeyDown: () => undefined,
  onTextareaPaste: () => undefined,
  onTextareaScrollSync: () => undefined,
  onTextareaInput: () => undefined,
  placeholder: 'Message',
  isTextareaExpanded: false,
  ...overrides,
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the composer passes adoptsBackground through to its send menu', () => {
  render(<UiPreferencesProvider><ChatComposer {...composerProps({ adoptsBackground: true })} /></UiPreferencesProvider>);
  const send = lastRow(open());

  assert.match(send.textContent ?? '', /Send now; the background work keeps running/);
  assert.ok(!looksDestructive(send));
});

test('the composer keeps Send anyway when the send would stop the work (an edit, or no capability)', () => {
  render(<UiPreferencesProvider><ChatComposer {...composerProps({ isEditingSentMessage: true, adoptsBackground: false })} /></UiPreferencesProvider>);
  const sendAnyway = lastRow(open());

  assert.match(sendAnyway.textContent ?? '', /^Send anyway/);
  assert.match(sendAnyway.textContent ?? '', /Send now; this stops the background work/);
  assert.ok(looksDestructive(sendAnyway));
});

test('the dialog reopened for a refused message says why it came back', () => {
  render(<BackgroundSendDialog prompt={{ work: ['Agent Survey the repo'], adoptRefused: true }} onResolve={() => undefined} />);

  assert.ok(screen.getByText('This message could not join the running session without stopping its background work.'));
  assert.ok(screen.getByText('Agent Survey the repo'));
  assert.ok(screen.getByRole('button', { name: 'Send anyway' }));
});

test('the dialog opened by a send says nothing about a refusal', () => {
  render(<BackgroundSendDialog prompt={{ work: ['Agent Survey the repo'] }} onResolve={() => undefined} />);

  assert.equal(screen.queryByText('This message could not join the running session without stopping its background work.'), null);
});
