import { afterEach, describe, expect, it, vi } from 'vitest';

// The hook module imports xterm and its addons at load time; only the pure colour
// resolver is under test here.
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }));

import { resolveTerminalColors } from '@/modules/shell/hooks/useShellTerminal';

function stubTokens(tokens: Record<string, string>) {
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    getPropertyValue: (name: string) => tokens[name] ?? '',
  } as unknown as CSSStyleDeclaration);
}

/** [local] The terminal palette is theme-ready: overridable, unchanged by default. */
describe('resolveTerminalColors', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the built-in palettes when no theme sets terminal tokens', () => {
    const dark = resolveTerminalColors(true);
    expect(dark.theme?.background).toBe('#1e1e1e');
    expect(dark.theme?.foreground).toBe('#d4d4d4');
    expect(dark.theme?.extendedAnsi).toHaveLength(16);
    expect(dark.minimumContrastRatio).toBe(1);

    const light = resolveTerminalColors(false);
    expect(light.theme?.background).toBe('#ffffff');
    expect(light.theme?.selectionBackground).toBe('#add6ff');
    expect(light.minimumContrastRatio).toBe(4.5);

    // Same object as before the refactor: nothing is rebuilt when nothing is themed.
    expect(resolveTerminalColors(true).theme).toBe(dark.theme);
  });

  it('applies only the tokens a theme sets, for the matching mode', () => {
    stubTokens({
      '--terminal-dark-background': '#0f1112',
      '--terminal-dark-selection-background': '#d9a25f55',
      '--terminal-dark-bright-red': '#e8745a',
      '--terminal-dark-minimum-contrast-ratio': '3',
      '--terminal-light-background': '#ebebe8',
    });

    const dark = resolveTerminalColors(true);
    expect(dark.theme?.background).toBe('#0f1112');
    expect(dark.theme?.selectionBackground).toBe('#d9a25f55');
    expect(dark.theme?.brightRed).toBe('#e8745a');
    expect(dark.theme?.foreground).toBe('#d4d4d4');
    expect(dark.minimumContrastRatio).toBe(3);

    const light = resolveTerminalColors(false);
    expect(light.theme?.background).toBe('#ebebe8');
    expect(light.theme?.foreground).toBe('#1f2328');
    expect(light.minimumContrastRatio).toBe(4.5);
  });

  it('ignores a contrast ratio that is not a number', () => {
    stubTokens({ '--terminal-light-minimum-contrast-ratio': 'high' });
    expect(resolveTerminalColors(false).minimumContrastRatio).toBe(4.5);
  });
});
