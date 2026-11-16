import { readUserPreference, writeUserPreference } from '@/shared/userSettings';

/**
 * [local] How the agent's spoken replies are framed in the transcript: no bubble,
 * a translucent one, or a solid one (the default). Stored as the `assistantBubble`
 * user preference, so it follows the user like the theme, and applied as
 * `data-assistant-bubble` on <html>, which the stylesheet keys on (src/index.css,
 * `.chat-assistant-bubble`). The default sets no attribute, so the unthemed
 * stylesheet needs no selector; index.html applies the mirrored value before React
 * mounts so a reload never flashes the other style.
 */

export const ASSISTANT_BUBBLE_STYLES = ['off', 'translucent', 'solid'] as const;

export type AssistantBubbleStyle = (typeof ASSISTANT_BUBBLE_STYLES)[number];

export const DEFAULT_ASSISTANT_BUBBLE: AssistantBubbleStyle = 'solid';

/** The `<html>` attribute the stylesheet keys on; also set by index.html. */
export const ASSISTANT_BUBBLE_ATTRIBUTE = 'data-assistant-bubble';

export function isAssistantBubbleStyle(value: unknown): value is AssistantBubbleStyle {
  return typeof value === 'string' && (ASSISTANT_BUBBLE_STYLES as readonly string[]).includes(value);
}

/** The stored style, or the default for an absent or unknown value. */
export function readStoredAssistantBubble(): AssistantBubbleStyle {
  const stored = readUserPreference<unknown>('assistantBubble', DEFAULT_ASSISTANT_BUBBLE);
  return isAssistantBubbleStyle(stored) ? stored : DEFAULT_ASSISTANT_BUBBLE;
}

/** Applies the style to the document; the default removes the attribute. */
export function applyAssistantBubble(style: AssistantBubbleStyle): void {
  if (typeof document === 'undefined') return;
  if (style === DEFAULT_ASSISTANT_BUBBLE) {
    document.documentElement.removeAttribute(ASSISTANT_BUBBLE_ATTRIBUTE);
  } else {
    document.documentElement.setAttribute(ASSISTANT_BUBBLE_ATTRIBUTE, style);
  }
}

export function writeAssistantBubble(style: AssistantBubbleStyle): void {
  writeUserPreference('assistantBubble', style);
}
