import { expect, test, vi } from 'vitest';
import { waitForUnload } from './service.js';

test('a retiring launchd registration must disappear before restart proceeds', () => {
  const loaded = vi
    .fn()
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(true)
    .mockReturnValue(false);
  const pause = vi.fn();
  waitForUnload(loaded, pause);
  expect(pause).toHaveBeenCalledTimes(2);
  expect(loaded).toHaveBeenCalledTimes(3);
});
test('a stuck service stops an update instead of claiming it restarted', () => {
  const pause = vi.fn();
  expect(() => waitForUnload(() => true, pause)).toThrow('still unloading');
  expect(pause).toHaveBeenCalledTimes(100);
});
