import { afterEach, describe, expect, it, vi } from 'vitest';

const pty = { start: vi.fn().mockResolvedValue({ session_handle: 'pty:a' }), send: vi.fn(), stop: vi.fn(), heartbeatProbe: vi.fn(),
  attach: vi.fn(), getOutputTail: vi.fn(), ownsSession: vi.fn(), detectInputBlock: vi.fn(), inspectSession: vi.fn() };
const tmux = { start: vi.fn().mockResolvedValue({ session_handle: 'tmux:a' }), send: vi.fn(), stop: vi.fn(), heartbeatProbe: vi.fn(),
  attach: vi.fn(), getOutputTail: vi.fn(), ownsSession: vi.fn(), detectInputBlock: vi.fn(), inspectSession: vi.fn(),
  survivesCoordinatorExit: (handle: string) => handle.startsWith('tmux:') };
let tmuxAvailable = true;
vi.mock('./pty.ts', () => ({ createPtyAdapter: () => pty }));
vi.mock('./tmux.ts', () => ({ createTmuxAdapter: () => tmux, isTmuxAvailable: () => tmuxAvailable }));

async function load(transport: string | undefined) {
  vi.resetModules();
  if (transport === undefined) delete process.env.ORC_SESSION_TRANSPORT;
  else process.env.ORC_SESSION_TRANSPORT = transport;
  return import('./index.ts');
}

afterEach(() => { process.env.ORC_SESSION_TRANSPORT = 'pty'; tmuxAvailable = true; vi.clearAllMocks(); });

describe('createAdapter transport routing', () => {
  it('starts new sessions on the resolved transport', async () => {
    expect((await load(undefined)).resolveSessionTransport()).toBe('tmux');
    await (await load('auto')).createAdapter('claude').start('a', {});
    expect(tmux.start).toHaveBeenCalled();
    tmuxAvailable = false;
    expect((await load('auto')).resolveSessionTransport()).toBe('pty');
    await (await load('pty')).createAdapter('claude').start('a', {});
    expect(pty.start).toHaveBeenCalled();
  });

  it('routes existing sessions by handle prefix regardless of the setting', async () => {
    const adapter = (await load('tmux')).createAdapter('codex');
    await adapter.send('pty:old', 'x');
    await adapter.stop('tmux:new');
    adapter.inspectSession('pty:old');
    void adapter.heartbeatProbe('tmux:new');
    expect(pty.send).toHaveBeenCalledWith('pty:old', 'x');
    expect(tmux.stop).toHaveBeenCalledWith('tmux:new');
    expect(pty.inspectSession).toHaveBeenCalledWith('pty:old');
    expect(tmux.heartbeatProbe).toHaveBeenCalledWith('tmux:new');
    expect(adapter.survivesCoordinatorExit('pty:old')).toBe(false);
    expect(adapter.survivesCoordinatorExit('tmux:new')).toBe(true);
  });

  it('rejects an invalid setting and a forced tmux that is not installed', async () => {
    const invalid = await load('screen');
    expect(() => invalid.resolveSessionTransport()).toThrow('Invalid ORC_SESSION_TRANSPORT');
    tmuxAvailable = false;
    await expect((await load('tmux')).createAdapter('claude').start('a', {})).rejects.toThrow('tmux is not available');
    expect(tmux.start).not.toHaveBeenCalled();
  });
});
