import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyAssistantBubble,
  ASSISTANT_BUBBLE_ATTRIBUTE,
  ASSISTANT_BUBBLE_STYLES,
  isAssistantBubbleStyle,
  readStoredAssistantBubble,
} from '@/shared/assistantBubble';
import { ThemeProvider, useTheme } from '@/shared/context/ThemeContext';
import { readUserPreference, resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * [local] The agent-bubble style is the `assistantBubble` user preference, applied
 * as `data-assistant-bubble` on <html>. The default (solid) must leave the document
 * attribute-free; unknown values fall back to it.
 */

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(ThemeProvider, null, children);

const attribute = () => document.documentElement.getAttribute(ASSISTANT_BUBBLE_ATTRIBUTE);

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  document.documentElement.removeAttribute(ASSISTANT_BUBBLE_ATTRIBUTE);
});

afterEach(() => {
  document.documentElement.removeAttribute(ASSISTANT_BUBBLE_ATTRIBUTE);
});

describe('assistant bubble styles', () => {
  it('knows off, translucent and solid, nothing else', () => {
    expect(ASSISTANT_BUBBLE_STYLES).toEqual(['off', 'translucent', 'solid']);
    expect(isAssistantBubbleStyle('translucent')).toBe(true);
    expect(isAssistantBubbleStyle('glass')).toBe(false);
    expect(isAssistantBubbleStyle(undefined)).toBe(false);
  });

  it('reads the stored style and falls back to solid for anything unknown', () => {
    expect(readStoredAssistantBubble()).toBe('solid');
    writeUserPreference('assistantBubble', 'off');
    expect(readStoredAssistantBubble()).toBe('off');
    writeUserPreference('assistantBubble', 'from-a-newer-client');
    expect(readStoredAssistantBubble()).toBe('solid');
  });

  it('applies the style as a document attribute and removes it for solid', () => {
    applyAssistantBubble('translucent');
    expect(attribute()).toBe('translucent');
    applyAssistantBubble('solid');
    expect(attribute()).toBeNull();
  });
});

describe('ThemeProvider', () => {
  it('starts from the stored style and applies it', () => {
    writeUserPreference('assistantBubble', 'off');
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.assistantBubble).toBe('off');
    expect(attribute()).toBe('off');
  });

  it('writes an explicit choice and applies it', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(attribute()).toBeNull();
    act(() => result.current.setAssistantBubble('translucent'));
    expect(result.current.assistantBubble).toBe('translucent');
    expect(attribute()).toBe('translucent');
    expect(readUserPreference('assistantBubble', null)).toBe('translucent');
    act(() => result.current.setAssistantBubble('solid'));
    expect(attribute()).toBeNull();
  });

  it('follows a value that arrives from the store without writing it back', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => writeUserPreference('assistantBubble', 'off'));
    expect(result.current.assistantBubble).toBe('off');
    expect(attribute()).toBe('off');
  });
});
