// [local] Layout of the compact phone composer toolbar (Settings > MobileUI).

/**
 * Tailwind classes for the compact phone toolbar. Below `sm` the footer never
 * wraps; the actions that moved into the "more" menu are hidden from the row,
 * and the model menu gives up width (its label truncates) before anything can
 * overflow. From `sm` up nothing changes.
 */
export const COMPACT_COMPOSER_CLASSES = {
  /** On the footer, next to the upstream `flex-wrap`. */
  footer: 'max-sm:flex-nowrap max-sm:gap-x-1',
  /** On the right-hand group (schedule, model, permission, send), which upstream keeps `shrink-0`. */
  controls: 'max-sm:min-w-0 max-sm:shrink',
  /** Around an action that the "more" menu offers on phones. */
  phoneHidden: 'contents max-sm:hidden',
  /** Around the model menu, so its trigger can shrink and truncate instead of wrapping the row. */
  modelSlot: 'contents max-sm:flex max-sm:min-w-0 max-sm:empty:hidden max-sm:[&>button]:min-w-11 max-sm:[&>button]:shrink',
} as const;
