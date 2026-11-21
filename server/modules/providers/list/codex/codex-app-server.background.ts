/**
 * [local] Background work of a Codex thread on the app-server runtime
 * (stage 4 of the Codex parity plan): the background terminals Codex keeps
 * running past a turn (unified exec processes) and the subagents it spawned.
 *
 * One tracker per loaded thread. It keeps the thread's live work, reports it
 * on the chat's stream in the shapes the Claude side already uses, so the
 * same strip, cards and composer state show it:
 *
 * - a background terminal is a `task_status` on the command's own card
 *   (`taskType: local_bash`, `taskId` = Codex's process id), so the strip
 *   lists it with a stop button;
 * - a subagent is a `Task` card (`subagent` info, live status, activity
 *   rows with `parentToolUseId`, the agent's last message as its result),
 *   the shape the history reader builds from the rollout;
 * - work that ends while no turn runs adds a `task_notification` row, the
 *   "report back" a finished background task gives on the Claude side.
 *   [local] Stage 5: the row carries a translatable `notice` and is kept in
 *   CloudCLI's database (`sink.recordNote`), since Codex's rollout does not
 *   record it; the live cards carry a `dedupeKey`, so a reload that brings
 *   back the rollout's card under another id does not show the card twice.
 *
 * The level signal is Codex's own: `thread/backgroundTerminals/list` for the
 * terminals and `thread/read` (thread status) for the subagents, polled while
 * a turn runs or anything is still live. The thread is not released while
 * anything is live (see `hasLiveWork`), because releasing it stops the
 * app-server child and everything running in it.
 */

import { createNormalizedMessage } from '@/shared/index.js';
import type { AnyRecord, BackgroundTaskSummary, NormalizedMessage, ProviderRuntimeWriter } from '@/shared/types.js';

import { sendMessage } from './codex-runtime.shared.js';

export type CodexBackgroundTerminal = {
  processId: string;
  /** The `commandExecution` item that started it: the card in the transcript. */
  itemId: string;
  command: string;
  startedAt: number;
};

export type CodexSubagentStatus = 'running' | 'completed' | 'failed' | 'stopped';

export type CodexSubagent = {
  /** The spawn call's item id: the card in the transcript. */
  toolId: string;
  /** The agent's own thread, once Codex named it. */
  threadId: string | null;
  description: string;
  name?: string;
  prompt?: string;
  model?: string;
  status: CodexSubagentStatus;
  /** The agent's last message, shown as the card's result. */
  result?: string;
  startedAt: number;
  /** `thread/read` reported the agent's thread active at least once. */
  seenActive?: boolean;
  /** `thread/read` reported it idle on this many reads in a row. */
  idleReads?: number;
};

/** Where a thread's rows go: the app session and the writer of its latest run. */
export type CodexBackgroundSink = {
  sessionKey: string;
  rowSessionId: string | null;
  writer: ProviderRuntimeWriter;
  normalize: (raw: AnyRecord, sessionId: string | null) => NormalizedMessage[];
  /** [local] Stage 5: keeps a row the rollout does not record (the report rows). */
  recordNote?: (message: NormalizedMessage) => void;
};

export type CodexBackgroundDeps = {
  request: (method: string, params: unknown) => Promise<unknown>;
  isConnected: () => boolean;
  /** Whether a turn of ours runs on the thread right now. */
  isTurnRunning: (threadId: string) => boolean;
  /** Called once nothing runs any more (no turn, no live work). */
  onIdle: (threadId: string) => void;
  pollMs: () => number;
  /** Maps a child thread's item to the exec event shape (`mapCodexAppServerItem`). */
  mapItem: (item: AnyRecord, phase: 'started' | 'completed') => AnyRecord | null;
};

/** CollabAgentStatus (0.169) as the card's status. */
export function subagentStatusFromCodex(status: unknown): CodexSubagentStatus | null {
  switch (status) {
    case 'pendingInit':
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'errored':
      return 'failed';
    case 'interrupted':
    case 'shutdown':
    case 'notFound':
      return 'stopped';
    default:
      return null;
  }
}

/** SubAgentActivityKind (0.169) as the card's status. */
function subagentStatusFromActivity(kind: unknown): CodexSubagentStatus | null {
  switch (kind) {
    case 'started':
    case 'interacted':
      return 'running';
    case 'completed':
      return 'completed';
    case 'interrupted':
      return 'stopped';
    default:
      return null;
  }
}

/** `task_name` / the last segment of `/root/<task>`, as the history reader labels the card. */
export function humanizeCodexAgentName(value: string): string {
  return value
    .replace(/__/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function promptHead(prompt: string | undefined): string | undefined {
  const head = prompt?.split('\n', 1)[0]?.trim();
  if (!head) {
    return undefined;
  }
  return head.length > 80 ? `${head.slice(0, 79)}…` : head;
}

/** Codex sends an encrypted transport blob instead of the prompt on some spawns; only readable text is shown. */
function readablePrompt(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && !/^gAAAAA/.test(value) ? value : undefined;
}

/**
 * The transcript rows of one subagent: its `Task` card (what it was asked,
 * its name and live status), plus the result row once it has settled. Same
 * id and tool name as the card the history reader builds, so a reload
 * replaces it instead of adding a second one.
 */
export function codexSubagentCardRows(agent: CodexSubagent, sessionId: string | null): NormalizedMessage[] {
  const rows: NormalizedMessage[] = [createNormalizedMessage({
    id: agent.toolId,
    kind: 'tool_use',
    toolName: 'Task',
    // [local] Stage 5: the history card names the agent by its thread too.
    ...(agent.threadId ? { dedupeKey: codexAgentDedupeKey(agent.threadId) } : {}),
    toolInput: {
      description: agent.description,
      ...(agent.prompt ? { prompt: agent.prompt } : {}),
    },
    toolId: agent.toolId,
    subagent: {
      id: agent.threadId ?? agent.toolId,
      description: agent.description,
      status: agent.status,
      ...(agent.name ? { name: agent.name } : {}),
      ...(agent.model ? { model: agent.model } : {}),
    },
    sessionId,
    provider: 'codex',
  })];
  if (agent.status !== 'running') {
    rows.push(createNormalizedMessage({
      id: `${agent.toolId}_result`,
      kind: 'tool_result',
      toolId: agent.toolId,
      content: agent.result ?? '',
      isError: agent.status === 'failed',
      sessionId,
      provider: 'codex',
    }));
  }
  return rows;
}

/**
 * [local] Stage 5: the key a live card is matched against the history card
 * by, when their ids differ. The client builds the same key from the history
 * card (`subagent.id`, the agent's thread; a Bash card's command).
 */
export function codexAgentDedupeKey(agentThreadId: string): string {
  return `agent:${agentThreadId}`;
}

export function codexCommandDedupeKey(command: unknown): string | undefined {
  const text = typeof command === 'string' ? command.trim() : '';
  return text ? `bash:${text}` : undefined;
}

/** One lifecycle event of a background terminal, folded onto its command's card by the client. */
export function codexTerminalTaskStatus(
  terminal: CodexBackgroundTerminal,
  event: 'started' | 'notification',
  status: 'running' | 'completed' | 'stopped',
  sessionId: string | null,
): NormalizedMessage {
  return createNormalizedMessage({
    id: `bgterm_${terminal.processId}_${event}_${status}`,
    kind: 'task_status',
    event,
    status,
    taskId: terminal.processId,
    toolUseId: terminal.itemId,
    taskType: 'local_bash',
    description: terminal.command,
    sessionId,
    provider: 'codex',
  });
}

/**
 * A subagent's status as a `task_status` on its card. It carries no task id:
 * a Codex subagent cannot be stopped from a client, so the strip offers no
 * stop for it. The status still holds when a history reload replaces the
 * card with the rollout's (which says "running" until the parent records
 * the agent's answer).
 */
export function codexSubagentTaskStatus(agent: CodexSubagent, sessionId: string | null): NormalizedMessage {
  const event = agent.status === 'running' ? 'started' : 'notification';
  return createNormalizedMessage({
    id: `bgagent_${agent.toolId}_${event}_${agent.status}`,
    kind: 'task_status',
    event,
    status: agent.status,
    toolUseId: agent.toolId,
    taskType: 'local_agent',
    description: agent.description,
    ...(agent.result ? { summary: shorten(agent.result) } : {}),
    sessionId,
    provider: 'codex',
  });
}

/**
 * A row in the transcript for work that ended after its turn: the "report
 * back". `summary` is the English text; [local] stage 5: `notice` is what the
 * client translates it from.
 */
function reportRow(
  id: string,
  summary: string,
  status: 'completed' | 'failed' | 'stopped',
  sessionId: string | null,
  notice: { code: string; params: Record<string, string> },
): NormalizedMessage {
  return createNormalizedMessage({
    id,
    kind: 'task_notification',
    status,
    summary,
    notice,
    sessionId,
    provider: 'codex',
  });
}

/** [local] Stage 5: the report row of a subagent that settled after its turn. */
export function codexAgentReportRow(
  agent: Pick<CodexSubagent, 'toolId' | 'name' | 'description' | 'result'>,
  status: Exclude<CodexSubagentStatus, 'running'>,
  sessionId: string | null,
): NormalizedMessage {
  const label = agent.name ?? agent.description;
  const result = agent.result ? shorten(agent.result) : '';
  if (status === 'completed') {
    return reportRow(
      `bgagent_${agent.toolId}_${status}`,
      `Agent finished: ${label}${result ? ` — ${result}` : ''}`,
      status,
      sessionId,
      result
        ? { code: 'codex_agent_finished_result', params: { name: label, result } }
        : { code: 'codex_agent_finished', params: { name: label } },
    );
  }
  return reportRow(
    `bgagent_${agent.toolId}_${status}`,
    status === 'failed' ? `Agent failed: ${label}` : `Agent stopped: ${label}`,
    status,
    sessionId,
    { code: status === 'failed' ? 'codex_agent_failed' : 'codex_agent_stopped', params: { name: label } },
  );
}

/** [local] Stage 5: the report row of a background command that ended after its turn. */
export function codexCommandReportRow(
  terminal: Pick<CodexBackgroundTerminal, 'processId' | 'command'>,
  status: 'completed' | 'stopped',
  sessionId: string | null,
): NormalizedMessage {
  const command = shorten(terminal.command);
  return reportRow(
    `bgterm_${terminal.processId}_report`,
    `Background command finished: ${command}`,
    status,
    sessionId,
    { code: 'codex_background_command_finished', params: { command } },
  );
}

function shorten(text: string, max = 120): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The text of the last agent message in a `thread/read` result with turns. */
function lastAgentMessage(thread: AnyRecord | undefined): string | undefined {
  const turns: AnyRecord[] = Array.isArray(thread?.turns) ? thread.turns : [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items: AnyRecord[] = Array.isArray(turns[turnIndex]?.items) ? turns[turnIndex].items : [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
        return item.text;
      }
    }
  }
  return undefined;
}

/**
 * The live background work of one loaded thread. See the module comment.
 */
export class CodexThreadBackground {
  readonly terminals = new Map<string, CodexBackgroundTerminal>();
  readonly agents = new Map<string, CodexSubagent>();
  private readonly toolIdByAgentThread = new Map<string, string>();
  /** Nicknames of spawned threads announced before their spawn named them. */
  private readonly nicknames = new Map<string, string>();
  /** Command items Codex reported as completed (their card has its end). */
  private readonly completedCommands = new Set<string>();
  /** Terminals CloudCLI stopped itself: their end is no report. */
  private readonly stopping = new Set<string>();
  private sink: CodexBackgroundSink | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<void> | null = null;
  private disposed = false;

  constructor(readonly threadId: string, private readonly deps: CodexBackgroundDeps) {}

  /** The run now writing for this thread; later rows go to its writer. */
  attach(sink: CodexBackgroundSink): void {
    this.sink = sink;
  }

  get sessionKey(): string | null {
    return this.sink?.sessionKey ?? null;
  }

  get writerSink(): CodexBackgroundSink | null {
    return this.sink;
  }

  hasLiveWork(): boolean {
    return this.terminals.size > 0 || [...this.agents.values()].some((agent) => agent.status === 'running');
  }

  isChildThread(threadId: string): boolean {
    return this.toolIdByAgentThread.has(threadId);
  }

  /** The live work as the running-sessions list and the subscribe ack report it. */
  listTasks(): BackgroundTaskSummary[] {
    const tasks: BackgroundTaskSummary[] = [];
    for (const terminal of this.terminals.values()) {
      tasks.push({
        taskId: terminal.processId,
        toolUseId: terminal.itemId,
        taskType: 'local_bash',
        description: terminal.command,
        startedAt: terminal.startedAt,
      });
    }
    for (const agent of this.agents.values()) {
      if (agent.status !== 'running') {
        continue;
      }
      tasks.push({
        taskId: `agent:${agent.threadId ?? agent.toolId}`,
        toolUseId: agent.toolId,
        taskType: 'local_agent',
        description: agent.description,
        startedAt: agent.startedAt,
        // Codex has no request to stop one subagent from a client.
        stoppable: false,
      });
    }
    return tasks;
  }

  private send(message: NormalizedMessage | AnyRecord): void {
    if (this.sink && !this.disposed) {
      sendMessage(this.sink.writer, message);
    }
  }

  /** [local] Stage 5: a report row is shown, and kept, since the rollout has no entry for it. */
  private sendReport(row: NormalizedMessage): void {
    if (this.sink && !this.disposed) {
      sendMessage(this.sink.writer, row);
      this.sink.recordNote?.(row);
    }
  }

  /**
   * [local] Stage 5: the live work's state again, after the turn's
   * `complete`. A page that reloads from here on is replayed only what came
   * after that `complete` (what came before is in the rollout it reads), but
   * the rollout does not say a command still runs or what state an agent is
   * in. Same ids as the first report, so a client that has them keeps one.
   */
  reannounce(): void {
    for (const terminal of this.terminals.values()) {
      // The card too: the status needs a card to fold onto, and its
      // `dedupeKey` finds the rollout's card if that has another id.
      if (!this.completedCommands.has(terminal.itemId)) {
        this.send(this.terminalCard(terminal, 'in_progress'));
      }
      this.send(codexTerminalTaskStatus(terminal, 'started', 'running', this.rowSessionId));
    }
    for (const agent of this.agents.values()) {
      if (agent.status === 'running') {
        this.sendAgentCard(agent);
        this.sendAgentStatus(agent);
      }
    }
  }

  private get rowSessionId(): string | null {
    return this.sink?.rowSessionId ?? this.threadId;
  }

  /**
   * A background command's card, as the turn first showed it. Stamped with
   * when the command was first listed, so it sorts with its turn and is
   * matched to the rollout's card by time as well as by command.
   */
  private terminalCard(terminal: CodexBackgroundTerminal, status: 'in_progress' | 'completed'): NormalizedMessage {
    return createNormalizedMessage({
      id: terminal.itemId,
      kind: 'tool_use',
      toolName: 'Bash',
      toolInput: { command: terminal.command },
      toolId: terminal.itemId,
      dedupeKey: codexCommandDedupeKey(terminal.command),
      status,
      timestamp: new Date(terminal.startedAt).toISOString(),
      sessionId: this.rowSessionId,
      provider: 'codex',
    });
  }

  noteCommandCompleted(itemId: string): void {
    this.completedCommands.add(itemId);
  }

  // -------------------------------------------------------------------------
  // Subagents

  private sendAgentCard(agent: CodexSubagent): void {
    for (const row of codexSubagentCardRows(agent, this.rowSessionId)) {
      this.send(row);
    }
  }

  /** The agent's status as a task event, once when it starts and once when it settles. */
  private sendAgentStatus(agent: CodexSubagent): void {
    this.send(codexSubagentTaskStatus(agent, this.rowSessionId));
  }

  private linkAgentThread(agent: CodexSubagent, threadId: string | null | undefined): void {
    if (typeof threadId === 'string' && threadId && !agent.threadId) {
      agent.threadId = threadId;
      this.toolIdByAgentThread.set(threadId, agent.toolId);
      const nickname = this.nicknames.get(threadId);
      if (nickname) {
        this.nicknames.delete(threadId);
        agent.name = nickname;
      }
    }
  }

  private agentByThread(threadId: unknown): CodexSubagent | undefined {
    const toolId = typeof threadId === 'string' ? this.toolIdByAgentThread.get(threadId) : undefined;
    return toolId ? this.agents.get(toolId) : undefined;
  }

  /**
   * Settles an agent: the card gets its status and result, and when no turn
   * runs the transcript gets a row saying it finished.
   */
  private settleAgent(agent: CodexSubagent, status: Exclude<CodexSubagentStatus, 'running'>, result?: string): void {
    if (agent.status !== 'running') {
      if (result && !agent.result) {
        agent.result = result;
        this.sendAgentCard(agent);
      }
      return;
    }
    agent.status = status;
    if (result) {
      agent.result = result;
    }
    this.sendAgentCard(agent);
    this.sendAgentStatus(agent);
    if (!this.deps.isTurnRunning(this.threadId)) {
      this.sendReport(codexAgentReportRow(agent, status, this.rowSessionId));
    }
  }

  /**
   * A `collabAgentToolCall` or `subAgentActivity` item of the thread. A spawn
   * becomes the agent's card; the others (wait, send, interrupt, …) only
   * update the agents' states, as the history reader shows no row for them.
   * True when the item was one of these.
   */
  onParentItem(item: AnyRecord, phase: 'started' | 'completed'): boolean {
    if (item?.type === 'subAgentActivity') {
      this.onSubAgentActivity(item);
      return true;
    }
    if (item?.type !== 'collabAgentToolCall') {
      return false;
    }
    const states: Record<string, AnyRecord> = item.agentsStates && typeof item.agentsStates === 'object' ? item.agentsStates : {};
    const receivers: string[] = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      : [];
    if (item.tool === 'spawnAgent' && typeof item.id === 'string') {
      let agent = this.agents.get(item.id);
      const isNew = !agent;
      if (!agent) {
        const prompt = readablePrompt(item.prompt);
        agent = {
          toolId: item.id,
          threadId: null,
          description: promptHead(prompt) ?? 'Agent',
          ...(prompt ? { prompt } : {}),
          ...(typeof item.model === 'string' && item.model ? { model: item.model } : {}),
          status: 'running',
          startedAt: Date.now(),
        };
        this.agents.set(item.id, agent);
      }
      this.linkAgentThread(agent, receivers[0]);
      const state = agent.threadId ? states[agent.threadId] : undefined;
      const spawnFailed = phase === 'completed' && item.status === 'failed' && !agent.threadId;
      const stateStatus = subagentStatusFromCodex(state?.status);
      if (spawnFailed) {
        this.settleAgent(agent, 'failed', typeof state?.message === 'string' ? state.message : undefined);
      } else if (stateStatus && stateStatus !== 'running') {
        this.settleAgent(agent, stateStatus, typeof state?.message === 'string' ? state.message : undefined);
      } else if (isNew || phase === 'completed') {
        this.sendAgentCard(agent);
        if (isNew) {
          this.sendAgentStatus(agent);
        }
      }
      this.ensurePolling();
      return true;
    }
    // wait / sendInput / followupTask / interruptAgent / closeAgent / …:
    // their reported states are the agents' latest word.
    for (const [threadId, state] of Object.entries(states)) {
      const agent = this.agentByThread(threadId);
      const status = subagentStatusFromCodex(state?.status);
      if (agent && status && status !== 'running') {
        this.settleAgent(agent, status, typeof state?.message === 'string' && state.message ? state.message : undefined);
      }
    }
    return true;
  }

  private onSubAgentActivity(item: AnyRecord): void {
    const agentThreadId = typeof item.agentThreadId === 'string' ? item.agentThreadId : null;
    let agent = this.agentByThread(agentThreadId);
    const agentPath = typeof item.agentPath === 'string' ? item.agentPath : '';
    const taskName = agentPath.split('/').filter(Boolean).pop();
    if (!agent && agentThreadId) {
      // An activity for an agent whose spawn this runtime did not see (it
      // was spawned before the thread was loaded here): link it to the one
      // spawn still waiting for its thread, else give it a card of its own.
      agent = [...this.agents.values()].find((candidate) => !candidate.threadId && candidate.status === 'running');
      if (!agent) {
        const toolId = typeof item.id === 'string' && item.id ? item.id : `subagent_${agentThreadId}`;
        agent = {
          toolId,
          threadId: null,
          description: taskName ? humanizeCodexAgentName(taskName) : 'Agent',
          status: 'running',
          startedAt: Date.now(),
        };
        this.agents.set(toolId, agent);
        this.sendAgentCard(agent);
        this.sendAgentStatus(agent);
      }
      this.linkAgentThread(agent, agentThreadId);
    }
    if (!agent) {
      return;
    }
    let changed = false;
    if (taskName) {
      const description = humanizeCodexAgentName(taskName);
      if (agent.description !== description && (!agent.prompt || agent.description === promptHead(agent.prompt) || agent.description === 'Agent')) {
        agent.description = description;
        changed = true;
      }
    }
    if (typeof item.model === 'string' && item.model && !agent.model) {
      agent.model = item.model;
      changed = true;
    }
    const status = subagentStatusFromActivity(item.kind);
    if (status && status !== 'running') {
      const settled = agent;
      if (status === 'completed' && !settled.result) {
        // The result first, so the card and the report carry it.
        void this.readAgentResult(settled).then((text) => this.settleAgent(settled, status, text));
      } else {
        this.settleAgent(settled, status);
      }
      return;
    }
    if (status === 'running' && agent.status !== 'running') {
      // Given more work (`followup_task`, `send_input`): running again.
      agent.status = 'running';
      agent.result = undefined;
      agent.seenActive = false;
      agent.idleReads = 0;
      this.sendAgentStatus(agent);
      changed = true;
    }
    if (changed) {
      this.sendAgentCard(agent);
    }
    this.ensurePolling();
  }

  /** A `thread/started` of a thread this one spawned: its nickname names the card. */
  onThreadStarted(thread: AnyRecord): void {
    const nickname = typeof thread?.agentNickname === 'string' && thread.agentNickname ? thread.agentNickname : undefined;
    const agent = this.agentByThread(thread?.id);
    if (!agent) {
      if (nickname && typeof thread?.id === 'string') {
        this.nicknames.set(thread.id, nickname);
      }
      return;
    }
    if (nickname && agent.name !== nickname) {
      agent.name = nickname;
      this.sendAgentCard(agent);
    }
  }

  /**
   * A notification of one of this thread's subagents. Its finished items are
   * the agent's live activity (rows under the card, by `parentToolUseId`);
   * its `turn/completed` settles the agent when it was the agent's work.
   */
  onChildNotification(method: string, params: AnyRecord): void {
    const agent = this.agentByThread(params.threadId);
    if (!agent || !this.sink) {
      return;
    }
    if (method === 'item/completed') {
      const item = params.item as AnyRecord;
      // The agent's own prompt, and its own agents (only its parent's card here).
      if (!item || item.type === 'userMessage' || item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity') {
        return;
      }
      if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
        agent.result = item.text;
      }
      const event = this.deps.mapItem(item, 'completed');
      if (!event) {
        return;
      }
      for (const row of this.sink.normalize(event, this.rowSessionId)) {
        // Under the card; never an anchor of the parent's transcript.
        this.send({ ...row, id: `${agent.toolId}_${row.id}`, parentToolUseId: agent.toolId });
      }
      return;
    }
    if (method === 'turn/completed' && agent.status === 'running') {
      // The agent's own turn ended (seen only if Codex streams a subagent's
      // thread to this client; the status read covers it otherwise).
      const status = params.turn?.status;
      this.settleAgent(agent, status === 'completed' ? 'completed' : status === 'interrupted' ? 'stopped' : 'failed');
    }
  }

  /** The agent's last message, read from its thread when no event carried it. */
  private async readAgentResult(agent: CodexSubagent): Promise<string | undefined> {
    if (agent.result) {
      return agent.result;
    }
    if (!agent.threadId || !this.deps.isConnected()) {
      return undefined;
    }
    try {
      const result = await this.deps.request('thread/read', { threadId: agent.threadId, includeTurns: true }) as AnyRecord | undefined;
      return lastAgentMessage(result?.thread);
    } catch {
      // The card keeps its status without a result.
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Terminals and the level poll

  /** Polls while a turn runs or anything is live; reports idle once neither. */
  ensurePolling(): void {
    if (this.pollTimer || this.disposed) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.refresh().finally(() => {
        if (this.disposed) {
          return;
        }
        if (this.deps.isTurnRunning(this.threadId) || this.hasLiveWork()) {
          this.ensurePolling();
        } else {
          this.deps.onIdle(this.threadId);
        }
      });
    }, this.deps.pollMs());
    this.pollTimer.unref?.();
  }

  /** Reads Codex's lists once and reports what started and what ended. Concurrent calls share one read. */
  refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.readLevels().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async readLevels(): Promise<void> {
    if (this.disposed || !this.deps.isConnected()) {
      return;
    }
    let listed: AnyRecord[] | null = null;
    try {
      listed = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const result = await this.deps.request('thread/backgroundTerminals/list', {
          threadId: this.threadId,
          ...(cursor ? { cursor } : {}),
        }) as AnyRecord | undefined;
        listed.push(...(Array.isArray(result?.data) ? result.data : []));
        cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
        if (!cursor) {
          break;
        }
      }
    } catch {
      // Not loaded any more, or the child went away: the exit handler reports.
      listed = null;
    }
    if (listed && !this.disposed) {
      this.applyTerminals(listed);
    }
    for (const agent of [...this.agents.values()]) {
      if (agent.status !== 'running' || !agent.threadId || this.disposed) {
        continue;
      }
      let type: unknown;
      try {
        const result = await this.deps.request('thread/read', { threadId: agent.threadId }) as AnyRecord | undefined;
        type = result?.thread?.status?.type;
      } catch {
        // No word (the read failed): the agent keeps its status, and its
        // events (`subAgentActivity`, `wait`) still settle it. It is never
        // taken for finished on a failed read, since releasing the thread
        // would stop it if it still ran.
        continue;
      }
      if (type === 'active') {
        agent.seenActive = true;
        agent.idleReads = 0;
      } else if (type === 'idle') {
        // Idle right after the spawn can be the moment before its first turn
        // starts: finished once it was seen active, or idle on two reads.
        agent.idleReads = (agent.idleReads ?? 0) + 1;
        if (agent.seenActive || agent.idleReads >= 2) {
          this.settleAgent(agent, 'completed', await this.readAgentResult(agent));
        }
      } else if (type === 'systemError') {
        this.settleAgent(agent, 'failed');
      } else if (type === 'notLoaded') {
        this.settleAgent(agent, agent.result ? 'completed' : 'stopped');
      }
    }
  }

  private applyTerminals(listed: AnyRecord[]): void {
    const seen = new Set<string>();
    for (const entry of listed) {
      const processId = typeof entry?.processId === 'string' ? entry.processId : null;
      const itemId = typeof entry?.itemId === 'string' ? entry.itemId : null;
      if (!processId || !itemId) {
        continue;
      }
      seen.add(processId);
      if (this.terminals.has(processId)) {
        continue;
      }
      const terminal: CodexBackgroundTerminal = {
        processId,
        itemId,
        command: typeof entry.command === 'string' ? entry.command : '',
        startedAt: Date.now(),
      };
      this.terminals.set(processId, terminal);
      this.send(codexTerminalTaskStatus(terminal, 'started', 'running', this.rowSessionId));
    }
    for (const terminal of [...this.terminals.values()]) {
      if (!seen.has(terminal.processId)) {
        this.endTerminal(terminal, this.stopping.has(terminal.processId) ? 'stopped' : 'completed');
      }
    }
  }

  private endTerminal(terminal: CodexBackgroundTerminal, status: 'completed' | 'stopped'): void {
    if (!this.terminals.delete(terminal.processId)) {
      return;
    }
    const stoppedHere = this.stopping.delete(terminal.processId);
    this.send(codexTerminalTaskStatus(terminal, 'notification', status, this.rowSessionId));
    if (!this.completedCommands.has(terminal.itemId)) {
      // Codex did not report the command's end on the stream: the card stops
      // spinning here; its output is in the rollout, which a reload reads.
      this.send(this.terminalCard(terminal, 'completed'));
    }
    if (!stoppedHere && !this.deps.isTurnRunning(this.threadId)) {
      this.sendReport(codexCommandReportRow(terminal, status, this.rowSessionId));
    }
  }

  /** Stops one background terminal. False when Codex no longer runs it. */
  async stopTerminal(processId: string): Promise<boolean> {
    const terminal = this.terminals.get(processId);
    if (!terminal) {
      return false;
    }
    this.stopping.add(processId);
    let terminated: boolean;
    try {
      const result = await this.deps.request('thread/backgroundTerminals/terminate', { threadId: this.threadId, processId }) as AnyRecord | undefined;
      terminated = result?.terminated === true;
    } catch (error) {
      this.stopping.delete(processId);
      throw error;
    }
    // Ended either way: by this stop, or before it (Codex no longer had it).
    this.endTerminal(terminal, 'stopped');
    if (!this.hasLiveWork() && !this.deps.isTurnRunning(this.threadId)) {
      this.deps.onIdle(this.threadId);
    }
    return terminated;
  }

  /**
   * "Stop all background work": every background terminal of the thread
   * (`thread/backgroundTerminals/clean`). Subagents are not touched: the
   * protocol has no request to stop one from a client. False when no terminal
   * was running.
   */
  async stopAllTerminals(): Promise<boolean> {
    const terminals = [...this.terminals.values()];
    if (terminals.length === 0) {
      return false;
    }
    for (const terminal of terminals) {
      this.stopping.add(terminal.processId);
    }
    try {
      await this.deps.request('thread/backgroundTerminals/clean', { threadId: this.threadId });
    } catch (error) {
      for (const terminal of terminals) {
        this.stopping.delete(terminal.processId);
      }
      throw error;
    }
    for (const terminal of terminals) {
      this.endTerminal(terminal, 'stopped');
    }
    if (!this.hasLiveWork() && !this.deps.isTurnRunning(this.threadId)) {
      this.deps.onIdle(this.threadId);
    }
    return true;
  }

  /** The child went away: everything that ran in it is gone. */
  markAllGone(): void {
    for (const terminal of [...this.terminals.values()]) {
      this.stopping.add(terminal.processId);
      this.endTerminal(terminal, 'stopped');
    }
    for (const agent of this.agents.values()) {
      if (agent.status === 'running') {
        this.settleAgent(agent, 'stopped');
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
