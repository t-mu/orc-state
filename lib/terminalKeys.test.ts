import { describe, expect, it } from 'vitest';
import { MODE_NOTICE, terminalKeyAction } from './terminalKeys.ts';

describe('terminalKeyAction', () => {
  it.each([['q'], ['\x1b'], ['\x04'], ['\x03'], ['\x1d']])('view mode: %j closes the tab', (key) => {
    expect(terminalKeyAction('view', key)).toEqual({ type: 'close' });
  });

  it('view mode: i starts typing', () => {
    expect(terminalKeyAction('view', 'i')).toEqual({ type: 'start-typing' });
  });

  it.each([['a'], ['\r'], ['\x1b[A'], ['qq'], ['\x04\x04'], ['ii'], ['Q']])('view mode: %j never reaches the agent', (key) => {
    expect(terminalKeyAction('view', key)).toEqual({ type: 'ignore' });
  });

  it.each([['q'], ['i'], ['\x1b'], ['\x04'], ['\x03'], ['hello\r'], ['\x1d\x1d']])('typing mode: %j goes to the agent', (key) => {
    expect(terminalKeyAction('typing', key)).toEqual({ type: 'send', data: key });
  });

  it.each([['q'], ['\x04'], ['\x1d'], ['a'], ['i']])('starting (lease on its way): %j is dropped, close keys included', (key) => {
    expect(terminalKeyAction('starting', key)).toEqual({ type: 'ignore' });
  });

  it('typing mode: Ctrl-] stops typing', () => {
    expect(terminalKeyAction('typing', '\x1d')).toEqual({ type: 'stop-typing' });
  });

  it('names each mode and its keys on one line', () => {
    expect(MODE_NOTICE.view).toBe('[view] i: type · q/Esc/Ctrl-D/Ctrl-C/Ctrl-]: close tab');
    expect(MODE_NOTICE.typing).toBe('[typing → agent] Ctrl-]: stop typing');
    for (const notice of Object.values(MODE_NOTICE)) expect(notice).not.toContain('\n');
  });
});
