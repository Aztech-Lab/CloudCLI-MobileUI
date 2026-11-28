import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import '@/shared/mobileUiI18n';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { writeMobileUiPreference } from '@/shared/mobileUiPreferences';
import { resetUserPreferences } from '@/shared/userSettings';
import * as useVoiceInputModule from '@/modules/chat/hooks/useVoiceInput';
import * as useVoiceAvailableModule from '@/modules/chat/hooks/useVoiceAvailable';

/**
 * [local] The compact phone composer toolbar (Settings > MobileUI): below `sm`
 * the footer stays one row, and clear context, schedule, the commands list and
 * voice input live in a "More actions" menu. jsdom applies no media queries, so
 * the layout is checked through the responsive classes that carry it.
 */

type Props = ComponentProps<typeof ChatComposer>;

const props = (overrides: Partial<Props>): Props => ({
  pendingPermissionRequests: [],
  handlePermissionDecision: () => undefined,
  handleGrantToolPermission: () => ({ success: true }),
  activity: null,
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
  attachmentRejections: [],
  onDismissAttachmentRejections: () => {},
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
  inputHighlightRef: createRef<HTMLDivElement>() as Props['inputHighlightRef'],
  renderInputWithMentions: (text) => text,
  textareaRef: createRef<HTMLTextAreaElement>() as Props['textareaRef'],
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

const MODELS: Props['availableModelOptions'] = [{ value: 'opus', label: 'Opus 5.5' }];

const renderComposer = (overrides: Partial<Props> = {}) =>
  render(<UiPreferencesProvider><ChatComposer {...props({ availableModelOptions: MODELS, model: 'opus', ...overrides })} /></UiPreferencesProvider>);

const footer = () => document.querySelector('[data-slot="prompt-input-footer"]') as HTMLElement;
const moreButton = () => screen.queryByRole('button', { name: 'More actions' });
/** The phone-hidden wrapper around an action of the row, or null when it is not wrapped. */
const phoneWrapperOf = (element: Element) => element.closest('.max-sm\\:hidden');
const openMore = () => {
  fireEvent.click(moreButton() as HTMLElement);
  return screen.getByRole('menu', { name: 'More actions' });
};

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('compact phone toolbar (default)', () => {
  it('keeps the footer on one row below sm and lets the controls shrink instead of wrapping', () => {
    renderComposer();
    const classes = footer().className.split(/\s+/);
    // Desktop keeps the upstream wrap (the hint row needs it); phones never wrap.
    expect(classes).toEqual(expect.arrayContaining(['flex-wrap', 'max-sm:flex-nowrap']));
    const controls = screen.getByRole('button', { name: 'Send' }).parentElement as HTMLElement;
    expect(controls.className).toContain('max-sm:shrink');
    expect(controls.className).toContain('max-sm:min-w-0');
    // The model trigger may shrink and truncate on phones.
    const model = screen.getByRole('button', { name: 'Select model and reasoning effort' });
    expect(model.parentElement?.className).toContain('max-sm:[&>button]:shrink');
  });

  it('hides clear context, schedule and the commands button from the phone row, and only there', () => {
    renderComposer({ onClearContext: vi.fn(), slashCommandsCount: 7 });
    for (const element of [
      screen.getByRole('button', { name: 'Clear context' }),
      screen.getByRole('button', { name: 'Schedule this message' }),
      screen.getByText('7').closest('button') as HTMLElement,
    ]) {
      const wrapper = phoneWrapperOf(element);
      expect(wrapper).not.toBeNull();
      expect(wrapper?.className).toContain('contents');
    }
    // Attach, token usage, model, permission mode and send stay in the row.
    for (const name of ['Attach files', 'Show token usage', 'Select model and reasoning effort', 'Send']) {
      expect(phoneWrapperOf(screen.getAllByRole('button', { name })[0])).toBeNull();
    }
    expect(moreButton()?.className).toContain('sm:hidden');
  });

  it('offers the moved actions in the More actions menu', () => {
    const onToggleCommandMenu = vi.fn();
    renderComposer({ onClearContext: vi.fn(), slashCommandsCount: 7, onToggleCommandMenu });
    const menu = openMore();
    const items = within(menu).getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['Show all commands7', 'Schedule this message', 'Clear context']);

    fireEvent.click(within(menu).getByRole('menuitem', { name: /Show all commands/ }));
    expect(onToggleCommandMenu).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu', { name: 'More actions' })).toBeNull();
  });

  it('leaves out clear context when the session cannot be cleared', () => {
    renderComposer();
    expect(within(openMore()).queryByRole('menuitem', { name: 'Clear context' })).toBeNull();
  });

  it('disables clear context while a turn runs', () => {
    const onClearContext = vi.fn();
    renderComposer({ onClearContext, isLoading: true });
    const clear = within(openMore()).getByRole('menuitem', { name: 'Clear context' }) as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
    fireEvent.click(clear);
    expect(onClearContext).not.toHaveBeenCalled();
  });

  it('schedules the typed message from the menu, and not with an empty composer', () => {
    const onScheduleMessage = vi.fn();
    const { rerender } = renderComposer({ onScheduleMessage });
    fireEvent.click(within(openMore()).getByRole('menuitem', { name: 'Schedule this message' }));
    // The menu turns into the schedule options.
    fireEvent.click(screen.getByRole('menuitemradio', { name: /In 15 minutes/ }));
    expect(onScheduleMessage).toHaveBeenCalledTimes(1);
    expect(onScheduleMessage.mock.calls[0][0]).toBeInstanceOf(Date);
    expect(screen.queryByRole('menu', { name: 'More actions' })).toBeNull();

    rerender(<UiPreferencesProvider><ChatComposer {...props({ onScheduleMessage, input: '', hasInput: false })} /></UiPreferencesProvider>);
    const schedule = within(openMore()).getByRole('menuitem', { name: 'Schedule this message' }) as HTMLButtonElement;
    expect(schedule.disabled).toBe(true);
  });

  it('offers voice input in the menu while idle and keeps the mic in the row while recording', () => {
    vi.spyOn(useVoiceAvailableModule, 'useVoiceAvailable').mockReturnValue(true);
    const toggle = vi.fn();
    const voice = vi.spyOn(useVoiceInputModule, 'useVoiceInput').mockReturnValue({ state: 'idle', toggle, stop: () => undefined });
    const { rerender } = renderComposer({ onVoiceTranscript: vi.fn() });
    const mic = document.querySelector('.lucide-mic') as Element;
    expect(phoneWrapperOf(mic)).not.toBeNull();
    fireEvent.click(within(openMore()).getByRole('menuitem', { name: 'Voice input' }));
    expect(toggle).toHaveBeenCalledTimes(1);

    voice.mockReturnValue({ state: 'recording', toggle, stop: () => undefined });
    rerender(<UiPreferencesProvider><ChatComposer {...props({ onVoiceTranscript: vi.fn() })} /></UiPreferencesProvider>);
    const stopRecording = document.querySelector('.lucide-square.text-red-500') as Element;
    expect(stopRecording).not.toBeNull();
    expect(phoneWrapperOf(stopRecording)).toBeNull();
  });

  it('leaves the send button and the one-tap Stop as they were', () => {
    const onAbortSession = vi.fn();
    renderComposer({ isLoading: true, onAbortSession, input: '', hasInput: false });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onAbortSession).toHaveBeenCalledTimes(1);
  });
});

describe('compact phone toolbar switched off', () => {
  it('renders the upstream row: no More actions menu, nothing phone-hidden, wrapping allowed', () => {
    writeMobileUiPreference('compactComposer', false);
    renderComposer({ onClearContext: vi.fn(), slashCommandsCount: 7 });
    expect(moreButton()).toBeNull();
    expect(footer().className).not.toContain('max-sm:flex-nowrap');
    expect(document.querySelector('.max-sm\\:hidden')).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear context' })).toBeTruthy();
  });

  it('follows the switch while the composer is open', () => {
    renderComposer();
    expect(moreButton()).not.toBeNull();
    act(() => writeMobileUiPreference('compactComposer', false));
    expect(moreButton()).toBeNull();
  });
});
