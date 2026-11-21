import type { ChatMessage } from '@/shared/types';

/** The error code of a send refused because the Codex app holds the thread's single writer. */
export const THREAD_HELD_ELSEWHERE_ERROR_CODE = 'codex_thread_active_writer';

/**
 * [local] Whether the conversation's thread was open in another program at the
 * last attempt: the newest row is the refusal (nothing ran after it). Read
 * only from what the server already said (the refused send's row, which it
 * keeps with the history), never by asking the Codex app.
 */
export function isThreadHeldElsewhere(messages: ChatMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === 'error' && message.errorCode === THREAD_HELD_ELSEWHERE_ERROR_CODE) {
      return true;
    }
    // The optimistic echo of the refused send sits just before its refusal;
    // anything else after it (a reply, a tool call, another error) means the
    // conversation moved on.
    if (message.type === 'user' || message.isTaskNotification) {
      continue;
    }
    return false;
  }
  return false;
}
