import type { NormalizedMessage } from '@/shared/types';

const LOCAL_USER_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const LOCAL_USER_DEDUPE_CLOCK_SKEW_MS = 10_000;
const LOCAL_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS = 30_000;

type UserTurnFingerprint = {
  text: string;
  imageCount: number;
  fileCount: number;
};

function userTurnFingerprint(message: NormalizedMessage): UserTurnFingerprint | null {
  if (message.kind !== 'text' || message.role !== 'user') return null;

  const text = (message.content || '').trim();
  const imageCount = Array.isArray(message.images) ? message.images.length : 0;
  const fileCount = Array.isArray(message.files) ? message.files.length : 0;
  if (!text && imageCount === 0 && fileCount === 0) return null;

  return { text, imageCount, fileCount };
}

function userTurnFingerprintsMatch(
  local: UserTurnFingerprint,
  server: UserTurnFingerprint,
): boolean {
  return (
    local.text === server.text
    && local.imageCount === server.imageCount
    && local.fileCount === server.fileCount
  );
}

function readMessageTime(message: NormalizedMessage): number | null {
  const time = Date.parse(message.timestamp);
  return Number.isFinite(time) ? time : null;
}

function findServerEchoForLocalUser(
  localMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  claimedServerIds: Set<string>,
): NormalizedMessage | null {
  const localFingerprint = userTurnFingerprint(localMessage);
  const localTime = readMessageTime(localMessage);
  if (!localFingerprint || localTime === null) {
    return null;
  }

  // The echo of an edited message may only be retired by a row that was not
  // in the transcript when the cut was made. Text and a time window are not
  // enough for it: a rewind that branches re-stamps every surviving turn to
  // the moment of the copy, so an earlier turn with the same words — "yes",
  // "continue", the typo being corrected — lands inside the window and would
  // retire the message the user just sent.
  const firstEligibleIndex = localMessage.replacesAfterRowCount ?? 0;

  const dedupeWindow = localFingerprint.text
    ? LOCAL_USER_DEDUPE_WINDOW_MS
    : LOCAL_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS;
  let closestMatch: NormalizedMessage | null = null;
  let closestTimeDifference = Number.POSITIVE_INFINITY;

  for (let index = firstEligibleIndex; index < serverMessages.length; index++) {
    const serverMessage = serverMessages[index];
    if (claimedServerIds.has(serverMessage.id)) {
      continue;
    }

    const serverFingerprint = userTurnFingerprint(serverMessage);
    if (!serverFingerprint || !userTurnFingerprintsMatch(localFingerprint, serverFingerprint)) {
      continue;
    }

    const serverTime = readMessageTime(serverMessage);
    if (
      serverTime === null
      || serverTime < localTime - LOCAL_USER_DEDUPE_CLOCK_SKEW_MS
      || serverTime - localTime > dedupeWindow
    ) {
      continue;
    }

    const timeDifference = Math.abs(serverTime - localTime);
    if (timeDifference < closestTimeDifference) {
      closestMatch = serverMessage;
      closestTimeDifference = timeDifference;
    }
  }

  return closestMatch;
}

/**
 * Removes local optimistic user rows once a corresponding persisted turn is
 * available. Matches are one-to-one so repeated sends cannot claim one row.
 */
export function removeOptimisticUserEchoes(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  const claimedServerIds = new Set<string>();

  return realtimeMessages.filter((message) => {
    if (!message.id.startsWith('local_')) {
      return true;
    }

    const serverEcho = findServerEchoForLocalUser(message, serverMessages, claimedServerIds);
    if (!serverEcho) {
      return true;
    }

    claimedServerIds.add(serverEcho.id);
    return false;
  });
}

/**
 * [local] How far apart a live command card and the persisted card of the
 * same command may be stamped. The persisted card is written when the model
 * makes the call, the live one when the command starts (or is first listed),
 * seconds apart; an earlier run of the same command is minutes away.
 */
const LIVE_COMMAND_MATCH_WINDOW_MS = 2 * 60 * 1000;

function readToolInputRecord(input: unknown): Record<string, unknown> | null {
  if (input && typeof input === 'object') {
    return input as Record<string, unknown>;
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * [local] The key a persisted card is matched to a live card by, in the form
 * the server gives live cards (`dedupeKey`): `agent:<agent thread id>` for a
 * subagent's card, `bash:<command>` for a command. Null for anything else.
 */
export function historyCardDedupeKey(message: NormalizedMessage): string | null {
  if (message.kind !== 'tool_use' || message.parentToolUseId) {
    return null;
  }
  const agentId = message.subagent && typeof message.subagent.id === 'string' ? message.subagent.id : '';
  if (agentId) {
    return `agent:${agentId}`;
  }
  if (message.toolName === 'Bash') {
    const command = readToolInputRecord(message.toolInput)?.command;
    const text = typeof command === 'string' ? command.trim() : '';
    return text ? `bash:${text}` : null;
  }
  return null;
}

/**
 * [local] Live cards the persisted transcript already holds under another id.
 *
 * Codex on the app-server runtime names a live tool card by the protocol's
 * item id, and its rollout may name the same call differently. Such a live
 * card carries a `dedupeKey`; once the history has a card with that key, the
 * live card is dropped and every live row that pointed at it (its result, its
 * task status, its subagent's activity) points at the history card instead,
 * so a reload or a history refresh shows one card. Rows without a
 * `dedupeKey` (every other provider, and Codex exec) are returned unchanged.
 *
 * Matching is one to one. An agent's card matches by its agent thread; a
 * command's matches the nearest persisted card of the same command stamped
 * within LIVE_COMMAND_MATCH_WINDOW_MS, so an earlier run of the same command
 * is never taken for it.
 */
export function reconcileLiveCardsWithHistory(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  if (!realtimeMessages.some((message) => message.dedupeKey)) {
    return realtimeMessages;
  }

  const serverToolIds = new Set<string>();
  const serverResultIds = new Set<string>();
  const historyCardsByKey = new Map<string, NormalizedMessage[]>();
  for (const message of serverMessages) {
    if (message.kind === 'tool_result' && message.toolId) {
      serverResultIds.add(message.toolId);
    }
    if (message.kind !== 'tool_use' || !message.toolId) {
      continue;
    }
    serverToolIds.add(message.toolId);
    const key = historyCardDedupeKey(message);
    if (key) {
      const cards = historyCardsByKey.get(key) ?? [];
      cards.push(message);
      historyCardsByKey.set(key, cards);
    }
  }
  // A history card that a live card already matches by id is that card's.
  const claimed = new Set<string>(realtimeMessages
    .filter((message) => message.kind === 'tool_use' && message.toolId && serverToolIds.has(message.toolId))
    .map((message) => message.toolId as string));

  const alias = new Map<string, string>();
  const considered = new Set<string>();
  for (const message of realtimeMessages) {
    if (message.kind !== 'tool_use' || !message.toolId || considered.has(message.toolId)) {
      continue;
    }
    const liveId = message.toolId;
    if (serverToolIds.has(liveId)) {
      considered.add(liveId);
      continue;
    }
    // The first row of a card that carries the key (a card can be sent
    // before it knows its agent's thread).
    const keyed = message.dedupeKey
      ? message
      : realtimeMessages.find((row) => row.kind === 'tool_use' && row.toolId === liveId && row.dedupeKey);
    if (!keyed?.dedupeKey) {
      continue;
    }
    considered.add(liveId);
    const candidates = (historyCardsByKey.get(keyed.dedupeKey) ?? [])
      .filter((card) => !claimed.has(card.toolId as string));
    let match: NormalizedMessage | undefined;
    if (keyed.dedupeKey.startsWith('agent:')) {
      match = candidates[0];
    } else {
      const liveTime = readMessageTime(message);
      let closest = Number.POSITIVE_INFINITY;
      for (const card of candidates) {
        const cardTime = readMessageTime(card);
        if (liveTime === null || cardTime === null) {
          continue;
        }
        const distance = Math.abs(cardTime - liveTime);
        if (distance <= LIVE_COMMAND_MATCH_WINDOW_MS && distance < closest) {
          closest = distance;
          match = card;
        }
      }
    }
    if (match?.toolId) {
      claimed.add(match.toolId);
      alias.set(liveId, match.toolId);
    }
  }

  if (alias.size === 0) {
    return realtimeMessages;
  }

  const reconciled: NormalizedMessage[] = [];
  for (const message of realtimeMessages) {
    if (message.kind === 'tool_use' && message.toolId && alias.has(message.toolId)) {
      continue;
    }
    let next = message;
    if (message.kind === 'tool_result' && message.toolId && alias.has(message.toolId)) {
      const target = alias.get(message.toolId) as string;
      if (serverResultIds.has(target)) {
        continue;
      }
      next = { ...next, toolId: target };
    }
    if (next.toolUseId && alias.has(next.toolUseId)) {
      next = { ...next, toolUseId: alias.get(next.toolUseId) };
    }
    if (next.parentToolUseId && alias.has(next.parentToolUseId)) {
      next = { ...next, parentToolUseId: alias.get(next.parentToolUseId) };
    }
    reconciled.push(next);
  }
  return reconciled;
}
