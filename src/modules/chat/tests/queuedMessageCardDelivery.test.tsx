import assert from 'node:assert/strict';

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, test } from 'vitest';

import { i18n } from '@/modules/i18n';
import QueuedMessageCard from '@/modules/chat/composer/QueuedMessageCard';
import { queuedDeliveryOf } from '@/modules/chat/composer/queuedDelivery';
import zhCNChat from '@/modules/i18n/locales/zh-CN/chat.json';
import zhTWChat from '@/modules/i18n/locales/zh-TW/chat.json';

/**
 * [local] The queued card says how the message will actually reach the agent,
 * so a message waiting for the reply, one joining the running session and one
 * waiting for background work no longer all read "Queued". Every label is
 * translated in Chinese, which the phone shows.
 */

afterEach(async () => {
  cleanup();
  await act(async () => { await i18n.changeLanguage('en'); });
});

const statusOf = () => screen.getByRole('status').textContent ?? '';

test('the delivery follows the reply, the mark and the background work', () => {
  assert.equal(queuedDeliveryOf({ isLoading: true, adoptHeld: true, background: false }), 'afterReply');
  assert.equal(queuedDeliveryOf({ isLoading: true, adoptHeld: undefined, background: true }), 'afterReply');
  assert.equal(queuedDeliveryOf({ isLoading: false, adoptHeld: true, background: true }), 'joinsRunning');
  assert.equal(queuedDeliveryOf({ isLoading: false, adoptHeld: undefined, background: true }), 'afterBackground');
  assert.equal(queuedDeliveryOf({ isLoading: true, adoptHeld: false, background: true }), 'afterBackground', 'refused once: it waits for the work');
  assert.equal(queuedDeliveryOf({ isLoading: false, adoptHeld: undefined, background: false }), 'afterReply');
});

test('each delivery reads differently', () => {
  const seen = new Set<string>();
  for (const delivery of ['afterReply', 'joinsRunning', 'afterBackground'] as const) {
    const view = render(<QueuedMessageCard content="hi" delivery={delivery} onEdit={() => undefined} onDelete={() => undefined} />);
    seen.add(view.container.textContent ?? '');
    view.unmount();
  }
  assert.equal(seen.size, 3);
});

test('a message joining the running session says so, in English', () => {
  render(<QueuedMessageCard content="what now?" delivery="joinsRunning" onEdit={() => undefined} onDelete={() => undefined} />);
  assert.match(document.body.textContent ?? '', /Sending/);
  assert.match(statusOf(), /Joins the running session/);
});

test('the default is after this reply', () => {
  render(<QueuedMessageCard content="next" onEdit={() => undefined} onDelete={() => undefined} />);
  assert.match(document.body.textContent ?? '', /Queued/);
  assert.match(statusOf(), /Sends after this reply/);
});

for (const [language, chat] of [['zh-CN', zhCNChat], ['zh-TW', zhTWChat]] as const) {
  test(`every queued-card label is translated in ${language}`, async () => {
    const queue = chat.input.queue as Record<string, string>;
    for (const key of ['label', 'labelJoining', 'willSendAfterReply', 'willJoin', 'willSendAfterBackground', 'edit', 'delete', 'sendNext', 'append']) {
      assert.ok(queue[key], `${language} input.queue.${key}`);
    }
    assert.ok((chat.sendMenu.queue as Record<string, string>).descriptionBackgroundKeepsWork);

    await act(async () => { await i18n.changeLanguage(language); });
    render(<QueuedMessageCard content="下一步" delivery="afterBackground" onEdit={() => undefined} onDelete={() => undefined} />);
    assert.equal(statusOf(), `· ${queue.willSendAfterBackground}`);
    assert.match(document.body.textContent ?? '', new RegExp(queue.label));
  });
}
