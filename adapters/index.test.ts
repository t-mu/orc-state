import { afterEach, describe, expect, it, vi } from 'vitest';

const pty = { start: vi.fn().mockResolvedValue({ session_handle: 'pty:a' }), send: vi.fn(), stop: vi.fn(), heartbeatProbe: vi.fn(),
  attach: vi.fn(), getOutputTail: vi.fn(), ownsSession: vi.fn(), detectInputBlock: vi.fn(), inspectSession: vi.fn() };
const tmux = { start: vi.fn().mockResolvedValue({ session_handle: 'tmux:a' }), send: vi.fn(), stop: vi.fn(), heartbeatProbe: vi.fn(),
  attach: vi.fn(), getOutputTail: vi.fn(), ownsSession: vi.fn(), detectInputBlock: vi.fn(), inspectSession: vi.fn(),
  survivesCoordinatorExit: (handle: string) => handle.startsWith('tmux:') };
const structured = { start: vi.fn().mockResolvedValue({ session_handle: 'app:a', provider_ref: { protocol_ready: true } }),
  submit: vi.fn().mockResolvedValue({ turn_id: 't1', mode: 'started' }), send: vi.fn(), stop: vi.fn(), heartbeatProbe: vi.fn(),
  attach: vi.fn(), getOutputTail: vi.fn(), ownsSession: vi.fn(), detectInputBlock: vi.fn(), inspectSession: vi.fn(),
  onEvent: vi.fn().mockReturnValue(() => {}),
  capabilities: { structured_events: true, command_ack: true, resume: true, steer: false, interrupt: false, approvals: false } };
let tmuxAvailable = true;
vi.mock('./codexAppServer.ts', () => ({ createCodexAppServerAdapter: () => structured, isAppServerHandle: (handle: string) => handle.startsWith('app:') }));
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

describe('createAdapter structured runtime (task 203)', () => {
  it('starts codex on the app-server runtime when asked and routes app: handles to it', async () => {
    const { createAdapter } = await load('pty');
    const { CLI_CAPABILITIES, isStructuredSession } = await import('./runtime.ts');
    const adapter = createAdapter('codex');
    await expect(adapter.start('a', { runtime: 'structured' })).resolves.toMatchObject({ session_handle: 'app:a' });
    expect(pty.start).not.toHaveBeenCalled();

    await adapter.submit('app:a', 'go', { commandId: 'cmd-1' });
    expect(structured.submit).toHaveBeenCalledWith('app:a', 'go', { commandId: 'cmd-1' });
    adapter.inspectSession('app:a');
    expect(structured.inspectSession).toHaveBeenCalledWith('app:a');
    expect(adapter.capabilitiesFor('app:a')).toBe(structured.capabilities);
    expect(adapter.capabilitiesFor('pty:a')).toBe(CLI_CAPABILITIES);
    expect(isStructuredSession(adapter, 'app:a')).toBe(true);
    expect(isStructuredSession(adapter, 'pty:a')).toBe(false);

    await adapter.start('b', {});
    expect(pty.start).toHaveBeenCalledTimes(1);
  });

  it('refuses protocol submission to a CLI session with a typed refusal', async () => {
    const adapter = (await load('pty')).createAdapter('codex');
    await expect(adapter.submit('pty:a', 'go')).rejects.toMatchObject({ name: 'CapabilityRefusal', code: 'unsupported_capability', capability: 'command_ack' });
    expect(pty.send).not.toHaveBeenCalled();
  });

  it('keeps providers without a proven protocol on an explicit CLI fallback', async () => {
    const adapter = (await load('pty')).createAdapter('claude');
    const result = await adapter.start('a', { runtime: 'structured' }) as { provider_ref: Record<string, unknown> };
    expect(structured.start).not.toHaveBeenCalled();
    expect(pty.start).toHaveBeenCalledTimes(1);
    expect(result.provider_ref.runtime_fallback).toContain('no proven structured runtime for claude');
    expect(adapter.capabilitiesFor('pty:a').command_ack).toBe(false);
  });
});
