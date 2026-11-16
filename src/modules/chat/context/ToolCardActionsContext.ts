import { createContext, useContext } from 'react';

/**
 * [local] What a running tool card can ask of the session's turn.
 *
 * `moveToBackground` sends `chat.background-task` for one running foreground
 * call (a shell command or subagent), as Ctrl+B does in the terminal. It is
 * null whenever that cannot work: no turn is running, the provider cannot
 * move work aside, or the transcript is rendered outside a live session (an
 * export). `refusedAt` holds, per tool_use id, when the server last answered
 * that nothing was moved, so the card can say so.
 */
export type ToolCardActions = {
  moveToBackground: ((toolUseId: string) => void) | null;
  refusedAt: ReadonlyMap<string, number>;
};

const NO_REFUSALS: ReadonlyMap<string, number> = new Map();

export const ToolCardActionsContext = createContext<ToolCardActions>({
  moveToBackground: null,
  refusedAt: NO_REFUSALS,
});

/** The running tool card's actions; inert outside ChatInterface. */
export function useToolCardActions(): ToolCardActions {
  return useContext(ToolCardActionsContext);
}
