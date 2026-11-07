import { afterEach, describe, expect, it, vi } from 'vitest';

const tmux = { start: vi.fn().mockResolvedValue({ session_handle: 'tmux:a' }), send: vi.fn(), stop: vi.fn(), heartbeatProbe: vi.fn(), exitStatus: vi.fn(),
  attach: vi.fn(), getOutputTail: vi.fn(), ownsSession: vi.fn(), detectInputBlock: vi.fn(), inspectSession: vi.fn(),
  survivesCoordinatorExit: (handle: string) => handle.startsWith('tmux:') };
const structured = { start: vi.fn().mockResolvedValue({ session_handle: 'app:a', provider_ref: { protocol_ready: true } }),
  submit: vi.fn().mockResolvedValue({ turn_id: 't1', mode: 'started' }), send: vi.fn(), stop: vi.fn(), heartbeatProbe: vi.fn(),
  attach: vi.fn(), getOutputTail: vi.fn(), ownsSession: vi.fn(), detectInputBlock: vi.fn(), inspectSession: vi.fn(),
  onEvent: vi.fn().mockReturnValue(() => {}),
  capabilities: { structured_events: true, command_ack: true, resume: true, steer: false, interrupt: false, approvals: false } };
const TMUX_OK = { ok: true, version: 'tmux 3.4', problem: null };
let tmuxCheck: { ok: boolean; version: string | null; problem: string | null } = TMUX_OK;
const checkTmux = vi.fn(() => tmuxCheck);
vi.mock('./codexAppServer.ts', () => ({ createCodexAppServerAdapter: () => structured, isAppServerHandle: (handle: string) => handle.startsWith('app:') }));
vi.mock('./tmux.ts', () => ({ createTmuxAdapter: () => tmux, checkTmux }));

async function load() {
  vi.resetModules();
  return import('./index.ts');
}

afterEach(() => { tmuxCheck = TMUX_OK; vi.clearAllMocks(); });

describe('createAdapter transport routing', () => {
  it('starts every new terminal session in tmux, checking tmux once', async () => {
    const adapter = (await load()).createAdapter('claude');
    await adapter.start('a', {});
    await adapter.start('b', {});
    expect(tmux.start).toHaveBeenCalledTimes(2);
    expect(checkTmux).toHaveBeenCalledTimes(1);
  });

  it('refuses to start when tmux is missing or too old', async () => {
    tmuxCheck = { ok: false, version: 'tmux 3.1c', problem: 'tmux 3.1c is too old; orc needs tmux >= 3.2' };
    await expect((await load()).createAdapter('claude').start('a', {})).rejects.toThrow('Cannot start a provider session: tmux 3.1c is too old');
    expect(tmux.start).not.toHaveBeenCalled();
  });

  it('routes tmux: handles to tmux', async () => {
    const adapter = (await load()).createAdapter('codex');
    await adapter.stop('tmux:new');
    void adapter.heartbeatProbe('tmux:new');
    expect(tmux.stop).toHaveBeenCalledWith('tmux:new');
    expect(tmux.heartbeatProbe).toHaveBeenCalledWith('tmux:new');
    expect(adapter.survivesCoordinatorExit('tmux:new')).toBe(true);
  });

  it('treats a legacy pty: handle as an offline session without throwing', async () => {
    const adapter = (await load()).createAdapter('claude');
    await expect(adapter.heartbeatProbe('pty:old')).resolves.toBe(false);
    expect(adapter.inspectSession('pty:old')).toEqual({
      transport: 'legacy', alive: false, writable: false, pid: null, processStart: null, reason: 'not a tmux or app-server session',
    });
    expect(adapter.ownsSession('pty:old')).toBe(false);
    expect(adapter.getOutputTail('pty:old')).toBeNull();
    expect(adapter.detectInputBlock('pty:old')).toBeNull();
    expect(adapter.exitStatus('pty:old')).toBeNull();
    await expect(adapter.stop('pty:old')).resolves.toBeUndefined();
    await expect(adapter.send('pty:old', 'x')).rejects.toThrow('Session pty:old is offline');
    expect(adapter.survivesCoordinatorExit('pty:old')).toBe(false);
    expect(tmux.send).not.toHaveBeenCalled();
    expect(tmux.heartbeatProbe).not.toHaveBeenCalled();
  });
});

describe('createAdapter structured runtime (task 203)', () => {
  it('starts codex on the app-server runtime when asked and routes app: handles to it', async () => {
    const { createAdapter } = await load();
    const { CLI_CAPABILITIES, isStructuredSession } = await import('./runtime.ts');
    const adapter = createAdapter('codex');
    await expect(adapter.start('a', { runtime: 'structured' })).resolves.toMatchObject({ session_handle: 'app:a' });
    expect(tmux.start).not.toHaveBeenCalled();

    await adapter.submit('app:a', 'go', { commandId: 'cmd-1' });
    expect(structured.submit).toHaveBeenCalledWith('app:a', 'go', { commandId: 'cmd-1' });
    adapter.inspectSession('app:a');
    expect(structured.inspectSession).toHaveBeenCalledWith('app:a');
    expect(adapter.capabilitiesFor('app:a')).toBe(structured.capabilities);
    expect(adapter.capabilitiesFor('tmux:a')).toBe(CLI_CAPABILITIES);
    expect(isStructuredSession(adapter, 'app:a')).toBe(true);
    expect(isStructuredSession(adapter, 'tmux:a')).toBe(false);

    await adapter.start('b', {});
    expect(tmux.start).toHaveBeenCalledTimes(1);
  });

  it('refuses protocol submission to a CLI session with a typed refusal', async () => {
    const adapter = (await load()).createAdapter('codex');
    await expect(adapter.submit('tmux:a', 'go')).rejects.toMatchObject({ name: 'CapabilityRefusal', code: 'unsupported_capability', capability: 'command_ack' });
    expect(tmux.send).not.toHaveBeenCalled();
  });

  it('keeps providers without a proven protocol on an explicit CLI fallback', async () => {
    const adapter = (await load()).createAdapter('claude');
    const result = await adapter.start('a', { runtime: 'structured' }) as { provider_ref: Record<string, unknown> };
    expect(structured.start).not.toHaveBeenCalled();
    expect(tmux.start).toHaveBeenCalledTimes(1);
    expect(result.provider_ref.runtime_fallback).toContain('no proven structured runtime for claude');
    expect(adapter.capabilitiesFor('tmux:a').command_ack).toBe(false);
  });
});
