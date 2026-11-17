import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { i18n } from '@/modules/i18n';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { BackgroundTasksStrip } from '@/modules/chat/transcript/BackgroundTasksStrip';
import {
  collectRunningBackgroundTasks,
  listRunningBackgroundLaunches,
  readBackgroundTaskId,
} from '@/modules/chat/utils/backgroundTasks';
import type { BackgroundTaskSummary, NormalizedMessage } from '@/shared/types';

/**
 * [local] Stage 4 of the Codex parity plan, on the client: what the Codex
 * app-server runtime sends for background terminals and subagents is drawn
 * by the same strip and cards Claude's background work uses.
 */

const at = (second: number) => `2026-11-16T10:00:${String(second).padStart(2, '0')}.000Z`;
const base = { sessionId: 's1', provider: 'codex' as const };

const commandCard = (status: string, second: number): NormalizedMessage => ({
  ...base,
  id: 'c1',
  timestamp: at(second),
  kind: 'tool_use',
  toolName: 'Bash',
  toolInput: { command: 'npm run dev' },
  toolId: 'c1',
  status,
});

const terminalEvent = (event: 'started' | 'notification', status: string, second: number): NormalizedMessage => ({
  ...base,
  id: `bgterm_1001_${event}_${status}`,
  timestamp: at(second),
  kind: 'task_status',
  event,
  status,
  taskId: '1001',
  toolUseId: 'c1',
  taskType: 'local_bash',
  description: 'npm run dev',
});

const agentCard = (status: string, second: number): NormalizedMessage => ({
  ...base,
  id: 's1',
  timestamp: at(second),
  kind: 'tool_use',
  toolName: 'Task',
  toolInput: { description: 'Count Files', prompt: 'Count the files in A' },
  toolId: 's1',
  subagent: { id: 'child-1', description: 'Count Files', status: status as 'running', name: 'Ada' },
});

const agentEvent = (event: 'started' | 'notification', status: string, second: number): NormalizedMessage => ({
  ...base,
  id: `bgagent_s1_${event}_${status}`,
  timestamp: at(second),
  kind: 'task_status',
  event,
  status,
  toolUseId: 's1',
  taskType: 'local_agent',
  description: 'Count Files',
});

describe('Codex background work on the client', () => {
  it('draws a tool call reported several times under one id as one card, where it first appeared', () => {
    const rows = normalizedToChatMessages([
      commandCard('in_progress', 1),
      { ...base, id: 'm1', timestamp: at(2), kind: 'text', role: 'assistant', content: 'Started the server.' },
      commandCard('completed', 3),
    ]);
    expect(rows.map((row) => row.toolName ?? row.content)).toEqual(['Bash', 'Started the server.']);
    expect(rows[0].toolStatus).toBe('completed');
  });

  it('a background terminal is a running command the strip can stop, until its end is reported', () => {
    const running = normalizedToChatMessages([commandCard('in_progress', 1), terminalEvent('started', 'running', 2)]);
    expect(listRunningBackgroundLaunches(running).map((row) => row.toolId)).toEqual(['c1']);
    expect(readBackgroundTaskId(running[0])).toBe('1001');
    expect(collectRunningBackgroundTasks(running).map((task) => [task.taskId, task.taskType])).toEqual([['1001', 'local_bash']]);

    const ended = normalizedToChatMessages([
      commandCard('in_progress', 1),
      terminalEvent('started', 'running', 2),
      terminalEvent('notification', 'completed', 5),
    ]);
    expect(listRunningBackgroundLaunches(ended)).toEqual([]);
  });

  it('a subagent card is listed while it runs, with no task id to stop it by, and settles from its status event', () => {
    const running = normalizedToChatMessages([agentCard('running', 1), agentEvent('started', 'running', 1)]);
    expect(running).toHaveLength(1);
    expect(running[0].isSubagentContainer).toBe(true);
    expect(listRunningBackgroundLaunches(running).map((row) => row.toolId)).toEqual(['s1']);
    expect(readBackgroundTaskId(running[0])).toBeUndefined();

    // The history reload says "running" until the parent records the answer;
    // the live status event still settles the card.
    const settled = normalizedToChatMessages([agentCard('running', 1), agentEvent('notification', 'completed', 9)]);
    expect(listRunningBackgroundLaunches(settled)).toEqual([]);
  });

  it('the strip offers no stop for a task the provider cannot stop, and says "stop all" stops the commands', () => {
    const sendMessage = vi.fn();
    const tasks: BackgroundTaskSummary[] = [
      { taskId: '1001', toolUseId: 'c1', taskType: 'local_bash', description: 'npm run dev', startedAt: 1 },
      { taskId: 'agent:child-1', toolUseId: 's1', taskType: 'local_agent', description: 'Count Files', startedAt: 1, stoppable: false },
    ];
    render(
      <BackgroundTasksStrip
        sessionId="s1"
        sendMessage={sendMessage}
        onReveal={() => {}}
        onLoadAll={() => {}}
        messages={normalizedToChatMessages([
          commandCard('in_progress', 1),
          terminalEvent('started', 'running', 2),
          agentCard('running', 3),
          agentEvent('started', 'running', 3),
        ])}
        tasks={tasks}
      />,
    );

    // One ✕: the command's.
    const stops = screen.getAllByRole('button', { name: 'Stop' });
    expect(stops).toHaveLength(1);
    fireEvent.click(stops[0]);
    expect(sendMessage).toHaveBeenLastCalledWith({ type: 'chat.stop-task', sessionId: 's1', taskId: '1001' });

    const stopAll = screen.getByRole('button', { name: /Stop all background commands/ });
    expect(stopAll.getAttribute('title')).toMatch(/Agents keep running/);
    fireEvent.click(stopAll);
    fireEvent.click(screen.getByRole('button', { name: /Tap again to stop all/ }));
    expect(sendMessage).toHaveBeenLastCalledWith({ type: 'chat.stop-all-background', sessionId: 's1' });
  });

  it('a session whose only work cannot be stopped shows it without any stop button', () => {
    render(
      <BackgroundTasksStrip
        sessionId="s1"
        sendMessage={() => {}}
        onReveal={() => {}}
        onLoadAll={() => {}}
        messages={[]}
        tasks={[{ taskId: 'agent:child-1', toolUseId: 's1', taskType: 'local_agent', description: 'Count Files', startedAt: 1, stoppable: false }]}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('Count Files');
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Stop all/ })).toBeNull();
  });

  it('has the new strings in Chinese', () => {
    expect(i18n.getFixedT('zh-CN')('workflow.stopAllBackgroundCommands')).toBe('停止全部后台命令');
    expect(i18n.getFixedT('zh-TW')('workflow.stopAllBackgroundCommands')).toBe('停止全部背景命令');
    expect(i18n.getFixedT('zh-CN')('workflow.stopAllBackgroundCommandsHint')).toMatch(/代理会继续运行/);
    expect(i18n.getFixedT('zh-CN', 'chat')('sendMenu.queue.descriptionBackgroundKeepsWork')).not.toMatch(/Claude/);
  });
});
