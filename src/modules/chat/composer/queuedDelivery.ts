/**
 * [local] How the queued message will reach the agent, in the words the card
 * shows: after the reply being written, into the running session while its
 * background work keeps running, or once that background work has ended.
 */
export type QueuedDelivery = 'afterReply' | 'joinsRunning' | 'afterBackground';

/**
 * [local] Reads the delivery off what the composer knows. A message marked
 * `adoptHeld: false` was refused by the running process and waits for its
 * work; any other message waits for a reply being written first; with no
 * reply, a marked one joins the running process at once.
 */
export function queuedDeliveryOf({ isLoading, adoptHeld, background }: {
  isLoading: boolean;
  adoptHeld: unknown;
  background: boolean;
}): QueuedDelivery {
  if (adoptHeld === false) {
    return 'afterBackground';
  }
  if (isLoading) {
    return 'afterReply';
  }
  if (adoptHeld === true) {
    return 'joinsRunning';
  }
  return background ? 'afterBackground' : 'afterReply';
}
