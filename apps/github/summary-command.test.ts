import { expect, test } from 'vitest';
import { summaryInput } from './summary-command.js';
import type { Message } from '../../src/core/types.js';
import type { Summary } from './summaries.js';
const message = { author: 'person', channel: 'room' } as Message;
test.each([
  ['--time'],
  ['--wat', 'value'],
  ['--enabled', 'yes'],
  ['--time', '09:00', '--time', '10:00'],
  ['--destination', '#another'],
  ['--org', 'owner', '--repos', 'owner/repo'],
])('rejects ambiguous or unsupported arguments %j', (...tokens) => {
  expect(() => summaryInput('daily', tokens, message)).toThrow();
});
test('patch preserves unspecified settings and default timezone removes override', () => {
  const existing = {
    id: 'daily',
    author: 'person',
    cadence: 'daily',
    scope: 'personal',
    targets: [],
    channel: 'room',
    time: '09:00',
    weekday: 1,
    timezone: 'Europe/London',
    enabled: true,
    skipEmpty: false,
    lastAt: 0,
  } as Summary;
  const { input, missing } = summaryInput(
    'daily',
    ['--time', '10:00', '--timezone', 'default'],
    message,
    existing,
  );
  expect(missing).toEqual([]);
  expect(input).toMatchObject({
    channel: 'room',
    time: '10:00',
    enabled: true,
    skipEmpty: false,
  });
  expect(input.timezone).toBeUndefined();
});
