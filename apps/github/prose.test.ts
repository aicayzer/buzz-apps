import { expect, test } from 'vitest';
import { activeProse } from './prose.js';
test.each([
  '> https://github.com/example/repo',
  '> Example\nhttps://github.com/example/repo',
  '```text\nhttps://github.com/example/repo\n```',
  '~~~\nhttps://github.com/example/repo\n~~~',
  '`https://github.com/example/repo`',
  '``https://github.com/example/repo``',
  '    https://github.com/example/repo',
])('omits quoted and code examples', (source) =>
  expect(activeProse(source)).not.toContain('https://github.com'),
);
test('keeps intentional normal and Markdown links following examples', () => {
  const url = 'https://github.com/example/repo';
  expect(activeProse('> example\n\n' + url)).toContain(url);
  expect(activeProse('[Repository](' + url + ')')).toContain(url);
});
