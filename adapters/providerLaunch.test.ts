import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bridgeProjectEnv, createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  dir = createTempStateDir('provider-launch-test-');
  process.env.ORC_STATE_DIR = dir;
  process.env.ORC_CODEX_PROMPT_WAIT_MS = '10';
});

afterEach(() => {
  cleanupTempStateDir(dir);
  delete process.env.ORC_STATE_DIR;
  delete process.env.ORC_CODEX_PROMPT_WAIT_MS;
});


function binaryMatcher(name: string) {
  return expect.stringMatching(new RegExp(`(^|/)${name}$`));
}

/**
 * Drives the launch the way the tmux adapter does: prepareProviderLaunch, then
 * runStartupDialogs. `spawnSpy` records what the terminal would run and
 * `session.write` every keystroke sent to it.
 */
/** The Codex SessionStart hook args a launch of `agentId` carries (codexSessionStartHookArgs). */
async function codexHook(agentId: string): Promise<string[]> {
  const { codexSessionStartHookArgs } = await import('./providerLaunch.ts');
  const { hookEventPath } = await import('../lib/paths.ts');
  return codexSessionStartHookArgs(hookEventPath(agentId));
}

async function makeAdapter({ provider = 'claude' }: { provider?: string } = {}) {
  const { prepareProviderLaunch, runStartupDialogs } = await import('./providerLaunch.ts');
  const spawnSpy = vi.fn();
  const session = { write: vi.fn() };
  const adapter = {
    async start(agentId: string, config: Record<string, unknown> = {}) {
      const launch = prepareProviderLaunch(provider, agentId, config);
      spawnSpy(launch.binary, launch.args, { cwd: launch.cwd, env: launch.env });
      await runStartupDialogs(session.write, provider, config, () => '');
    },
  };
  return { adapter, spawnSpy, session };
}

// ─── prepareProviderLaunch() + runStartupDialogs() ─────────────────────────

describe('provider launch', () => {
  it('launches the CLI binary with the per-agent settings file', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { execution_mode: 'full-access' });

    expect(spawnSpy).toHaveBeenCalledWith(binaryMatcher('claude'), expect.arrayContaining(['--dangerously-skip-permissions', '--settings']), expect.any(Object));
    // --settings path should point to the per-agent settings file
    const spawnArgs = spawnSpy.mock.calls[0][1] as string[];
    expect(spawnArgs[0]).toBe('--dangerously-skip-permissions');
    expect(spawnArgs[1]).toBe('--settings');
    expect(spawnArgs[2]).toMatch(/pty-settings[/\\]bob\.json$/);
  });

  it('starts a Claude conversation under the orc-chosen id, and resumes it with --resume', async () => {
    const first = await makeAdapter({ provider: 'claude' });
    await first.adapter.start('bob', { conversation_id: 'conv-1' });
    const args = first.spawnSpy.mock.calls[0][1] as string[];
    expect(args.slice(args.indexOf('--session-id'), args.indexOf('--session-id') + 2)).toEqual(['--session-id', 'conv-1']);
    expect(args).not.toContain('--resume');

    vi.resetModules();
    const resumed = await makeAdapter({ provider: 'claude' });
    await resumed.adapter.start('bob', { conversation_id: 'ignored', resume_conversation_id: 'conv-1' });
    const resumeArgs = resumed.spawnSpy.mock.calls[0][1] as string[];
    expect(resumeArgs.slice(resumeArgs.indexOf('--resume'), resumeArgs.indexOf('--resume') + 2)).toEqual(['--resume', 'conv-1']);
    expect(resumeArgs).not.toContain('--session-id');
    // Settings (hooks, sandbox) and MCP isolation are the same as on a first launch.
    expect(resumeArgs).toEqual(expect.arrayContaining(['--settings', '--strict-mcp-config']));
  }, 20_000);

  it('writes a settings file with SessionStart and Notification hooks for claude provider', async () => {
    const { adapter } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', {});

    const settingsFile = join(dir, 'pty-settings', 'bob.json');
    expect(existsSync(settingsFile)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    const events = join(dir, 'pty-hook-events', 'bob.ndjson');
    const cmd = (kind: string) => ({ type: 'command', command: expect.stringMatching(new RegExp(`orc-hook\\.ts" ${kind} ".*bob\\.ndjson"$`)) });
    expect(settings.hooks).toEqual({
      SessionStart: [{ hooks: [cmd('session_start')] }],
      Notification: [{ hooks: [cmd('permission')] }],
      PostToolUse: [{ matcher: '*', hooks: [cmd('tool')] }],
      PostToolUseFailure: [{ matcher: '*', hooks: [cmd('tool')] }],
      PreToolUse: [{ matcher: '*', hooks: [cmd('tool_start')] }, { matcher: 'TodoWrite|TaskCreate|TaskUpdate', hooks: [cmd('todo')] }],
      // A task worker also gets the stop-hook run guard (asserted in detail below).
      Stop: [{ hooks: [{ type: 'command', command: expect.stringMatching(/ stop-check$/), timeout: 15 }] }],
    });
    expect(settings.hooks.Notification[0].hooks[0].command).toContain(JSON.stringify(events));
  });

  it('the generated hook commands run and append session_start/permission/tool/activity records', async () => {
    const { adapter } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', {});
    const settings = JSON.parse(readFileSync(join(dir, 'pty-settings', 'bob.json'), 'utf8'));
    const run = (command: string, payload: unknown) => {
      const result = spawnSync('sh', ['-c', command], { input: JSON.stringify(payload), encoding: 'utf8' });
      expect(result.status).toBe(0);
    };
    run(settings.hooks.SessionStart[0].hooks[0].command, { session_id: 'conv-1', source: 'startup' });
    run(settings.hooks.Notification[0].hooks[0].command, { notification_type: 'permission_prompt', message: 'Allow Bash?' });
    run(settings.hooks.PreToolUse[0].hooks[0].command, { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'npm test' } });
    run(settings.hooks.PostToolUse[0].hooks[0].command, { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'npm test' } });
    run(settings.hooks.PreToolUse[1].hooks[0].command, { tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'X', status: 'in_progress', activeForm: 'Doing X' }] } });
    const records = readFileSync(join(dir, 'pty-hook-events', 'bob.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as unknown);
    expect(records).toEqual([
      { type: 'session_start', session_id: 'conv-1', source: 'startup', ts: expect.any(String) },
      { type: 'permission', message: 'Allow Bash?', ts: expect.any(String) },
      { type: 'tool_start', tool: 'Bash', id: 'toolu_1', ts: expect.any(String) },
      { type: 'tool', tool: 'Bash', brief: 'npm test', id: 'toolu_1', ts: expect.any(String) },
      { type: 'activity', label: 'Doing X', source: 'todo', ts: expect.any(String) },
    ]);
  });

  it('gives a full-access codex session its SessionStart hook as launch args, whose command appends the readiness record', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'codex' });
    await adapter.start('cx', { execution_mode: 'full-access', system_prompt: 'SCOUT' });
    const args = spawnSpy.mock.calls[0][1] as string[];
    const at = args.indexOf('--dangerously-bypass-hook-trust');
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe('-c');
    const match = /^hooks\.SessionStart=\[\{hooks=\[\{type="command",command=(".*")\}\]\}\]$/.exec(args[at + 2]);
    expect(match).not.toBeNull();
    // The prompt stays last: Codex fires SessionStart when it starts the thread.
    expect(args.at(-1)).toBe('SCOUT');
    // Nothing is written for Codex: no settings file.
    expect(existsSync(join(dir, 'pty-settings', 'cx.json'))).toBe(false);
    const command = JSON.parse(match![1]) as string;
    // The payload shape Codex 0.163 sends on stdin.
    const payload = { session_id: 'thread-1', hook_event_name: 'SessionStart', source: 'startup', cwd: dir, model: 'm', permission_mode: 'default' };
    const result = spawnSync('sh', ['-c', command], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ORC_SESSION_ID: 'orc-session-1' } });
    expect(result.status).toBe(0);
    const records = readFileSync(join(dir, 'pty-hook-events', 'cx.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as unknown);
    expect(records).toEqual([{ type: 'session_start', session_id: 'thread-1', source: 'startup', orc_session_id: 'orc-session-1', ts: expect.any(String) }]);
  });

  it('gives a sandboxed codex session (workers and scouts) no hook and no trust bypass', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'codex' });
    await adapter.start('cw', { execution_mode: 'sandbox', system_prompt: 'BOOT' });
    await adapter.start('cs', { execution_mode: 'sandbox', read_only: true, system_prompt: 'SCOUT' });
    for (const call of spawnSpy.mock.calls) {
      const args = call[1] as string[];
      expect(args).not.toContain('--dangerously-bypass-hook-trust');
      expect(args.some((arg) => arg.startsWith('hooks.'))).toBe(false);
    }
  });

  it('gives a claude task worker a Stop hook that runs `orc stop-check` from its ORC_BIN', async () => {
    const { adapter } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { env: { ORC_BIN: "/opt/it's/orc" } });

    const settings = JSON.parse(readFileSync(join(dir, 'pty-settings', 'bob.json'), 'utf8'));
    expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: "'/opt/it'\\''s/orc' stop-check", timeout: 15 }] }]);
  });

  it('gives a read-only scout its SessionStart hook but no tool hooks and no Stop hook', async () => {
    const { adapter } = await makeAdapter({ provider: 'claude' });
    await adapter.start('scout-1', { execution_mode: 'sandbox', read_only: true });

    const settings = JSON.parse(readFileSync(join(dir, 'pty-settings', 'scout-1.json'), 'utf8'));
    expect(Object.keys(settings.hooks)).toEqual(['SessionStart', 'Notification']);
  });

  it('launches the provider inside the requested working directory when provided', async () => {
    const worktree = join(dir, 'worktree');
    mkdirSync(worktree);
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { working_directory: worktree, execution_mode: 'full-access' });

    expect(spawnSpy).toHaveBeenCalledWith(binaryMatcher('claude'), expect.arrayContaining(['--dangerously-skip-permissions']), expect.objectContaining({
      cwd: worktree,
    }));
  });

  it('launches in the working directory (task 204)', async () => {
    const worktree = join(dir, 'worktree');
    mkdirSync(worktree);
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { working_directory: worktree, execution_mode: 'full-access' });

    expect(spawnSpy.mock.calls[0][2]).toMatchObject({ cwd: worktree });
  });

  it('fails clearly without spawning when the working directory is missing', async () => {
    const missing = join(dir, 'missing-worktree');
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await expect(adapter.start('bob', { working_directory: missing })).rejects.toThrow(`assigned working directory does not exist: ${missing}`);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('fails clearly when a worker working directory is not a git checkout', async () => {
    const worktree = join(dir, 'half-removed-worktree');
    mkdirSync(worktree);
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await expect(adapter.start('bob', { working_directory: worktree, require_git_checkout: true }))
      .rejects.toThrow(`assigned working directory is not a git worktree: ${worktree}`);
    expect(spawnSpy).not.toHaveBeenCalled();

    writeFileSync(join(worktree, '.git'), 'gitdir: /somewhere/.git/worktrees/run-1\n');
    await adapter.start('bob', { working_directory: worktree, require_git_checkout: true });
    expect(spawnSpy.mock.calls[0][2]).toMatchObject({ cwd: worktree });
  });

  it('fails clearly when a worker has no assigned worktree at all', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await expect(adapter.start('bob', { require_git_checkout: true }))
      .rejects.toThrow('worker launch requires an assigned worktree');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('fails clearly when the working directory is not a directory', async () => {
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, '');
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await expect(adapter.start('bob', { working_directory: file })).rejects.toThrow('assigned working directory is not a directory');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('merges explicit environment overrides into the spawned provider process', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', {
      execution_mode: 'full-access',
      env: {
        ORC_STATE_DIR: '/tmp/shared-state',
        ORC_PROJECT_ID: 'p1',
      },
    });

    expect(spawnSpy).toHaveBeenCalledWith(binaryMatcher('claude'), expect.arrayContaining(['--dangerously-skip-permissions']), expect.objectContaining({
      env: expect.objectContaining({
        ORC_STATE_DIR: '/tmp/shared-state',
        ORC_PROJECT_ID: 'p1',
      }),
    }));
  });

  it('strips parent provider session env vars before spawning nested codex workers', async () => {
    process.env.CODEX_SANDBOX = 'seatbelt';
    process.env.CODEX_THREAD_ID = 'thread-123';
    process.env.CODEX_CI = '1';

    const { adapter, spawnSpy } = await makeAdapter({ provider: 'codex' });
    await adapter.start('codex-worker', {
      execution_mode: 'full-access',
      env: { ORC_PROJECT_ID: 'p1' },
    });

    expect(spawnSpy).toHaveBeenCalledWith(
      binaryMatcher('codex'),
      expect.any(Array),
      expect.objectContaining({
        env: expect.not.objectContaining({
          CODEX_SANDBOX: expect.any(String),
          CODEX_THREAD_ID: expect.any(String),
          CODEX_CI: expect.any(String),
        }),
      }),
    );
  });

  it('delivers bootstrap via session writes when system_prompt provided', async () => {
    const { adapter, session } = await makeAdapter();
    await adapter.start('bob', { execution_mode: 'full-access', system_prompt: 'BOOTSTRAP TEXT' });

    // Claude: Enter (trust/bypass dismiss) + '2' + Enter (bypass accept),
    // then bootstrap text + CR.
    expect(session.write).toHaveBeenNthCalledWith(1, '\r');
    expect(session.write).toHaveBeenNthCalledWith(2, '2');
    expect(session.write).toHaveBeenNthCalledWith(3, '\r');
    expect(session.write).toHaveBeenNthCalledWith(4, 'BOOTSTRAP TEXT');
    expect(session.write).toHaveBeenNthCalledWith(5, '\r');
  });

  it('auto-accepts startup dialogs even when system_prompt is absent', async () => {
    const { adapter, session } = await makeAdapter();
    await adapter.start('bob', { execution_mode: 'full-access' });

    // Claude writes CR (trust dismiss) + '2' + CR (bypass accept).
    expect(session.write).toHaveBeenCalledTimes(3);
    expect(session.write).toHaveBeenNthCalledWith(1, '\r');
    expect(session.write).toHaveBeenNthCalledWith(2, '2');
    expect(session.write).toHaveBeenNthCalledWith(3, '\r');
  });

  it('uses provider binary mapping for codex and gemini', async () => {
    const codex = await makeAdapter({ provider: 'codex' });
    await codex.adapter.start('c', { execution_mode: 'full-access' });
    expect(codex.spawnSpy).toHaveBeenCalledWith(binaryMatcher('codex'), ['--dangerously-bypass-approvals-and-sandbox', '--enable', 'multi_agent', '-c', 'mcp_servers.orchestrator={command="true",enabled=false}', ...await codexHook('c')], expect.any(Object));

    vi.resetModules();
    const gemini = await makeAdapter({ provider: 'gemini' });
    await gemini.adapter.start('g', { execution_mode: 'full-access' });
    expect(gemini.spawnSpy).toHaveBeenCalledWith(binaryMatcher('gemini'), ['--allowed-mcp-server-names', 'orc-no-mcp-servers'], expect.any(Object));
  });

  it('passes codex bootstrap as a CLI prompt argument', async () => {
    const { adapter, spawnSpy, session } = await makeAdapter({ provider: 'codex' });
    await adapter.start('codex-worker', { execution_mode: 'full-access', system_prompt: 'BOOTSTRAP TEXT' });

    expect(spawnSpy).toHaveBeenCalledWith(
      binaryMatcher('codex'),
      ['--dangerously-bypass-approvals-and-sandbox', '--enable', 'multi_agent', '-c', 'mcp_servers.orchestrator={command="true",enabled=false}', ...await codexHook('codex-worker'), 'BOOTSTRAP TEXT'],
      expect.any(Object),
    );
    expect(session.write).toHaveBeenNthCalledWith(1, '\r');
    expect(session.write).not.toHaveBeenCalledWith('BOOTSTRAP TEXT');
  });

  it('uses bypass mode for codex scout sessions too', async () => {
    const { adapter, spawnSpy, session } = await makeAdapter({ provider: 'codex' });
    await adapter.start('scout-1', { system_prompt: 'SCOUT', read_only: true });

    expect(spawnSpy).toHaveBeenCalledWith(
      binaryMatcher('codex'),
      ['--dangerously-bypass-approvals-and-sandbox', '--enable', 'multi_agent', '-c', 'mcp_servers.orchestrator={command="true",enabled=false}', ...await codexHook('scout-1'), 'SCOUT'],
      expect.any(Object),
    );
    expect(session.write).toHaveBeenNthCalledWith(1, '\r');
    expect(session.write).not.toHaveBeenCalledWith('SCOUT');
  });

  it('preserves the normal Codex startup Enter outside the smoke harness', async () => {
    const { adapter, session } = await makeAdapter({ provider: 'codex' });
    await adapter.start('codex-worker', { execution_mode: 'full-access', system_prompt: 'BOOTSTRAP TEXT' });

    expect(session.write).toHaveBeenNthCalledWith(1, '\r');
  });

  it('does not send a blind Codex startup Enter in smoke mode when no workspace prompt is present', async () => {
    const { adapter, session } = await makeAdapter({ provider: 'codex' });
    await adapter.start('codex-worker', {
      execution_mode: 'full-access',
      system_prompt: 'BOOTSTRAP TEXT',
      startup_profile: 'real-provider-smoke',
    });

    expect(session.write).not.toHaveBeenCalled();
  });

});

// ─── buildStartArgs execution mode ─────────────────────────────────────────

describe('buildStartArgs execution mode', () => {
  it('claude full-access: --dangerously-skip-permissions', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { execution_mode: 'full-access' });

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  it('claude sandbox: --permission-mode auto', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { execution_mode: 'sandbox' });

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--permission-mode');
    expect(args).toContain('auto');
  });

  it('claude sandbox: no --dangerously-skip-permissions', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { execution_mode: 'sandbox' });

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('claude sandbox: settings file includes sandbox config block', async () => {
    const { adapter } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { execution_mode: 'sandbox' });

    const settingsFile = join(dir, 'pty-settings', 'bob.json');
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect(settings).toMatchObject({
      sandbox: {
        enabled: true,
        mode: 'auto-allow',
        allowUnsandboxedCommands: false,
      },
    });
    // cwd first; the state dir is never granted, and its operator token is hidden.
    expect(settings.sandbox.filesystem.allowWrite[0]).toBe('.');
    expect(settings.sandbox.filesystem.allowWrite).not.toContain(dir);
    expect(settings.sandbox.filesystem.denyRead).toEqual([join(dir, 'operator.token')]);
  });

  it('claude sandbox + read_only: settings file has no allowWrite', async () => {
    const { adapter } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { execution_mode: 'sandbox', read_only: true });

    const settingsFile = join(dir, 'pty-settings', 'bob.json');
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect(settings.sandbox).toBeDefined();
    expect(settings.sandbox.filesystem).toEqual({ denyRead: [join(dir, 'operator.token')] });
  });

  it('claude sandbox + read_only in a project: may still connect to the control socket', async () => {
    const socket = join(dir, 'control.sock');
    const { adapter } = await makeAdapter({ provider: 'claude' });
    await adapter.start('scout-1', { execution_mode: 'sandbox', read_only: true, env: { ORC_CONTROL_SOCKET: socket } });
    const settings = JSON.parse(readFileSync(join(dir, 'pty-settings', 'scout-1.json'), 'utf8'));
    // No writable roots, but the operator's credential is hidden from it (task 231).
    expect(settings.sandbox.filesystem).toEqual({ denyRead: [join(dir, 'operator.token')] });
    expect(settings.permissions).toEqual({ deny: [`Read(/${join(dir, 'operator.token')})`] });
    expect(settings.sandbox.network.allowUnixSockets).toEqual([socket]);
  });

  it('codex full-access: --dangerously-bypass-approvals-and-sandbox', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'codex' });
    await adapter.start('c', { execution_mode: 'full-access' });

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('codex sandbox: --sandbox workspace-write --ask-for-approval never', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'codex' });
    await adapter.start('c', { execution_mode: 'sandbox' });

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--sandbox');
    expect(args).toContain('workspace-write');
    expect(args).toContain('--ask-for-approval');
    expect(args).toContain('never');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('codex sandbox + read_only: --sandbox read-only --ask-for-approval never', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'codex' });
    await adapter.start('c', { execution_mode: 'sandbox', read_only: true });

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('--ask-for-approval');
    expect(args).toContain('never');
  });

  it('starts every provider with no MCP servers, so a worker cannot reach the master\'s orchestrator tools', async () => {
    const claude = await makeAdapter({ provider: 'claude' });
    await claude.adapter.start('w', { execution_mode: 'full-access' });
    expect(claude.spawnSpy.mock.calls[0][1]).toContain('--strict-mcp-config');
    expect(claude.spawnSpy.mock.calls[0][1]).not.toContain('--mcp-config');
  });

  it('gemini: only the MCP isolation flag in either mode', async () => {
    const gemini1 = await makeAdapter({ provider: 'gemini' });
    await gemini1.adapter.start('g', { execution_mode: 'full-access' });
    expect(gemini1.spawnSpy).toHaveBeenCalledWith(binaryMatcher('gemini'), ['--allowed-mcp-server-names', 'orc-no-mcp-servers'], expect.any(Object));

    vi.resetModules();
    const gemini2 = await makeAdapter({ provider: 'gemini' });
    await gemini2.adapter.start('g', { execution_mode: 'sandbox' });
    expect(gemini2.spawnSpy).toHaveBeenCalledWith(binaryMatcher('gemini'), ['--allowed-mcp-server-names', 'orc-no-mcp-servers'], expect.any(Object));
  });

  it('undefined execution_mode defaults to full-access behavior (claude)', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', {});

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('undefined execution_mode defaults to full-access behavior (codex)', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'codex' });
    await adapter.start('c', {});

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});

// ─── sandbox scoping (task 190) ─────────────────────────────────────────────

describe('sandboxExtraWritableRoots', () => {
  const opts = { readOnly: false, cwd: '/data/projects/p1/worktrees/run-1', stateDir: '/data/projects/p1', gitRepoRoot: '/orch' };

  it('worktree cwd: grants the backing repo .git write subtrees, never the state dir', async () => {
    const { sandboxExtraWritableRoots } = await import('./providerLaunch.ts');
    expect(sandboxExtraWritableRoots(opts)).toEqual([
      '/orch/.git/objects',
      '/orch/.git/refs',
      '/orch/.git/logs',
      '/orch/.git/worktrees',
    ]);
  });

  it('worktree cwd, separate target: grants the target repo .git, not the state dir', async () => {
    const { sandboxExtraWritableRoots } = await import('./providerLaunch.ts');
    expect(sandboxExtraWritableRoots({ ...opts, gitRepoRoot: '/target' })).toEqual([
      '/target/.git/objects',
      '/target/.git/refs',
      '/target/.git/logs',
      '/target/.git/worktrees',
    ]);
  });

  it('project worker (task 229): grants the control socket, never the state dir', async () => {
    const { sandboxExtraWritableRoots } = await import('./providerLaunch.ts');
    const socket = '/data/projects/p1/control.sock';
    const roots = sandboxExtraWritableRoots({ ...opts, gitRepoRoot: '/target', controlSocket: socket });
    expect(roots).toEqual([socket, '/target/.git/objects', '/target/.git/refs', '/target/.git/logs', '/target/.git/worktrees']);
    expect(roots).not.toContain('/data/projects/p1');
  });

  it('never grants the escalation-sensitive .git, .git/hooks or .git/config paths', async () => {
    const { sandboxExtraWritableRoots } = await import('./providerLaunch.ts');
    const roots = sandboxExtraWritableRoots(opts);
    expect(roots).not.toContain('/orch/.git');
    expect(roots).not.toContain('/orch/.git/hooks');
    expect(roots).not.toContain('/orch/.git/config');
    expect(roots).not.toContain('/orch');
  });

  it('drops roots already inside the cwd (launch at the orchestration root)', async () => {
    const { sandboxExtraWritableRoots } = await import('./providerLaunch.ts');
    expect(sandboxExtraWritableRoots({ ...opts, cwd: '/orch' })).toEqual([]);
  });

  it('read-only (scouts): no writable roots', async () => {
    const { sandboxExtraWritableRoots } = await import('./providerLaunch.ts');
    expect(sandboxExtraWritableRoots({ ...opts, readOnly: true })).toEqual([]);
  });
});

describe('claudeSandboxFilesystem', () => {
  const opts = { readOnly: false, cwd: '/data/projects/p1/worktrees/run-1', stateDir: '/data/projects/p1', gitRepoRoot: '/target' };

  it('writable: grants the cwd plus the extra roots', async () => {
    const { claudeSandboxFilesystem } = await import('./providerLaunch.ts');
    expect(claudeSandboxFilesystem(opts)).toEqual({
      allowWrite: [
        '.',
        '/target/.git/objects',
        '/target/.git/refs',
        '/target/.git/logs',
        '/target/.git/worktrees',
      ],
    });
  });

  it('read-only (scouts): no filesystem block', async () => {
    const { claudeSandboxFilesystem } = await import('./providerLaunch.ts');
    expect(claudeSandboxFilesystem({ ...opts, readOnly: true })).toBeUndefined();
  });
});

describe('codexSandboxWritableRootArgs', () => {
  const opts = { readOnly: false, cwd: '/data/projects/p1/worktrees/run-1', stateDir: '/data/projects/p1', gitRepoRoot: '/target' };

  it('writable: grants the extra roots via the writable_roots override', async () => {
    const { codexSandboxWritableRootArgs } = await import('./providerLaunch.ts');
    expect(codexSandboxWritableRootArgs(opts))
      .toEqual(['-c', 'sandbox_workspace_write.writable_roots='
        + '["/target/.git/objects","/target/.git/refs","/target/.git/logs","/target/.git/worktrees"]']);
  });

  it('no args when the cwd already covers every root', async () => {
    const { codexSandboxWritableRootArgs } = await import('./providerLaunch.ts');
    expect(codexSandboxWritableRootArgs({ ...opts, cwd: '/', gitRepoRoot: '/orch' })).toEqual([]);
  });

  it('JSON-encodes the value so a path with special characters stays well-formed', async () => {
    const { codexSandboxWritableRootArgs } = await import('./providerLaunch.ts');
    const args = codexSandboxWritableRootArgs({ ...opts, gitRepoRoot: '/tmp/a"b\\c' });
    // The value after the `=` must parse as JSON (raw interpolation would break here).
    const value = args[1].slice('sandbox_workspace_write.writable_roots='.length);
    expect(() => JSON.parse(value)).not.toThrow();
    expect(JSON.parse(value)).toContain('/tmp/a"b\\c/.git/objects');
  });

  it('read-only (scouts): no writable-root args', async () => {
    const { codexSandboxWritableRootArgs } = await import('./providerLaunch.ts');
    expect(codexSandboxWritableRootArgs({ ...opts, readOnly: true })).toEqual([]);
  });
});

describe('sandbox roots end-to-end via start() (task 204)', () => {
  // A project: its state directory (holding the run worktrees) and its target repository are different roots.
  function twoRootLayout() {
    const stateDir = join(dir, 'state');
    const target = join(dir, 'target');
    const worktree = join(stateDir, 'worktrees', 'run-1');
    mkdirSync(worktree, { recursive: true });
    Object.assign(process.env, bridgeProjectEnv(stateDir, target));
    return { target, worktree, stateDir };
  }

  function gitRoots(repo: string) {
    return ['objects', 'refs', 'logs', 'worktrees'].map((sub) => join(repo, '.git', sub));
  }

  afterEach(() => {
    delete process.env.ORC_PROJECT_ID;
  });

  it('claude, two roots: launches in the worktree and grants the target .git only', async () => {
    const { target, worktree, stateDir } = twoRootLayout();
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { execution_mode: 'sandbox', working_directory: worktree });
    expect(spawnSpy).toHaveBeenCalledWith(binaryMatcher('claude'), expect.any(Array), expect.objectContaining({ cwd: worktree }));
    const settings = JSON.parse(readFileSync(join(stateDir, 'pty-settings', 'bob.json'), 'utf8'));
    expect(settings.sandbox.filesystem.allowWrite).toEqual(['.', ...gitRoots(target)]);
  });

  it('claude, project worker (task 229): no state dir grant; the socket is the only lifecycle path', async () => {
    const { target, worktree, stateDir } = twoRootLayout();
    const socket = join(stateDir, 'control.sock');
    const { adapter } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { execution_mode: 'sandbox', working_directory: worktree, env: { ORC_CONTROL_SOCKET: socket } });
    const settings = JSON.parse(readFileSync(join(stateDir, 'pty-settings', 'bob.json'), 'utf8'));
    expect(settings.sandbox.filesystem.allowWrite).toEqual(['.', socket, ...gitRoots(target)]);
    expect(settings.sandbox.filesystem.allowWrite).not.toContain(stateDir);
    expect(settings.sandbox.network.allowUnixSockets).toEqual([socket]);
  });

  it('claude sandbox network (task 230): Linux allows every Unix socket only with sandbox_network open', async () => {
    const { claudeSandboxNetwork } = await import('./providerLaunch.ts');
    expect(claudeSandboxNetwork('/s.sock', 'restricted', 'linux')).toEqual({ allowUnixSockets: ['/s.sock'] });
    expect(claudeSandboxNetwork('/s.sock', 'open', 'darwin')).toEqual({ allowUnixSockets: ['/s.sock'] });
    expect(claudeSandboxNetwork('/s.sock', 'open', 'linux')).toEqual({ allowUnixSockets: ['/s.sock'], allowAllUnixSockets: true });
  });

  it('codex, project worker (task 230): network access only with the sandbox_network opt-in', async () => {
    const { target, worktree, stateDir } = twoRootLayout();
    const socket = join(stateDir, 'control.sock');
    const roots = ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([socket, ...gitRoots(target)])}`];
    const codex = await makeAdapter({ provider: 'codex' });
    await codex.adapter.start('c', { execution_mode: 'sandbox', working_directory: worktree, env: { ORC_CONTROL_SOCKET: socket } });
    expect(codex.spawnSpy.mock.calls[0][1]).toEqual(['--sandbox', 'workspace-write', '--ask-for-approval', 'never', ...roots, '--enable', 'multi_agent', '-c', 'mcp_servers.orchestrator={command="true",enabled=false}']);
    await codex.adapter.start('d', { execution_mode: 'sandbox', sandbox_network: 'open', working_directory: worktree, env: { ORC_CONTROL_SOCKET: socket } });
    expect(codex.spawnSpy.mock.calls[1][1]).toEqual([
      '--sandbox', 'workspace-write', '--ask-for-approval', 'never', ...roots,
      '-c', 'sandbox_workspace_write.network_access=true', '--enable', 'multi_agent', '-c', 'mcp_servers.orchestrator={command="true",enabled=false}',
    ]);
    const { codexSandboxNetworkArgs } = await import('./providerLaunch.ts');
    expect(codexSandboxNetworkArgs({ readOnly: true, cwd: worktree, stateDir, gitRepoRoot: target, controlSocket: socket }, 'open')).toEqual([]);
    expect(codexSandboxNetworkArgs({ readOnly: false, cwd: worktree, stateDir, gitRepoRoot: target }, 'open')).toEqual([]);
  });

  it('codex grants the same roots, and gemini gets no sandbox flags, with two roots', async () => {
    const { target, worktree } = twoRootLayout();
    const codex = await makeAdapter({ provider: 'codex' });
    await codex.adapter.start('c', { execution_mode: 'sandbox', working_directory: worktree });
    expect(codex.spawnSpy.mock.calls[0][1]).toEqual([
      '--sandbox', 'workspace-write', '--ask-for-approval', 'never',
      '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(gitRoots(target))}`,
      '--enable', 'multi_agent', '-c', 'mcp_servers.orchestrator={command="true",enabled=false}',
    ]);
    expect(codex.spawnSpy.mock.calls[0][2]).toMatchObject({ cwd: worktree });

    vi.resetModules();
    const gemini = await makeAdapter({ provider: 'gemini' });
    await gemini.adapter.start('g', { execution_mode: 'sandbox', working_directory: worktree });
    expect(gemini.spawnSpy).toHaveBeenCalledWith(binaryMatcher('gemini'), ['--allowed-mcp-server-names', 'orc-no-mcp-servers'], expect.objectContaining({ cwd: worktree }));
  });
});

// ─── claude auto-accept dance ───────────────────────────────────────────────

describe('claude auto-accept dance', () => {
  it('fires in full-access mode', async () => {
    const { adapter, session } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { execution_mode: 'full-access' });

    expect(session.write).toHaveBeenCalledWith('2');
    expect(session.write).toHaveBeenCalledWith('\r');
  });

  it('does not fire in sandbox mode', async () => {
    const { adapter, session } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { execution_mode: 'sandbox' });

    expect(session.write).not.toHaveBeenCalledWith('2');
  });

  it('fires when execution_mode is undefined (backward compat)', async () => {
    const { adapter, session } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', {});

    expect(session.write).toHaveBeenCalledWith('2');
    expect(session.write).toHaveBeenCalledWith('\r');
  });
});
// ─── detectBlockingPromptFromText() ──────────────────────────────────────────

describe('detectBlockingPromptFromText()', () => {
  let detect: (text: string) => string | null;
  let detectWorkspace: (text: string) => string | null;

  beforeEach(async () => {
    const mod = await import('./providerLaunch.ts');
    detect = mod.detectBlockingPromptFromText;
    detectWorkspace = mod.detectCodexWorkspacePromptFromText;
  });

  // -- bracket/paren forms --

  it('matches [y/n] square-bracket form', () => {
    expect(detect('Apply these changes? [y/n]')).toBe('Apply these changes? [y/n]');
  });

  it('detects the Codex workspace confirmation prompt text', () => {
    expect(detectWorkspace('You are in /tmp/test\n1. Yes, continue\nPress enter to continue\n')).toBe('Press enter to continue');
  });

  it('does not detect a Codex workspace prompt from unrelated text', () => {
    expect(detectWorkspace('Codex ready.\nWaiting for input.\n')).toBeNull();
  });

  it('matches (y/n) parenthesis form', () => {
    expect(detect('Apply these changes? (y/n)')).toBe('Apply these changes? (y/n)');
  });

  it('matches [yes/no] square-bracket form', () => {
    expect(detect('Continue? [yes/no]')).toBe('Continue? [yes/no]');
  });

  it('matches (yes/no) parenthesis form', () => {
    expect(detect('Continue? (yes/no)')).toBe('Continue? (yes/no)');
  });

  // -- verb-led prompts without a trailing question mark --

  it('matches verb-led prompt without question mark ("Would you like … [y/n]")', () => {
    expect(detect('Would you like to proceed [y/n]')).toBe('Would you like to proceed [y/n]');
  });

  it('matches "grant" verb-led prompt', () => {
    expect(detect('Grant access to this resource? (y/n)')).toBe('Grant access to this resource? (y/n)');
  });

  it('matches "permit" verb-led prompt', () => {
    expect(detect('Permit execution of this script? [y/n]')).toBe('Permit execution of this script? [y/n]');
  });

  // -- ANSI stripping --

  it('strips ANSI escape codes before matching', () => {
    expect(detect('\x1b[32mContinue?\x1b[0m [y/n]')).toBe('Continue? [y/n]');
  });

  // -- multi-line: scan from bottom --

  it('returns the matching line closest to the bottom of multi-line text', () => {
    const text = 'Some earlier output\nApply patch? [y/n]\nInstall package? [y/n]';
    expect(detect(text)).toBe('Install package? [y/n]');
  });

  // -- quota / rate-limit path --

  it('returns matching line for rate limit text', () => {
    expect(detect('API rate limit exceeded. Try again later.')).toBe('API rate limit exceeded. Try again later.');
  });

  it('returns matching line for context window exhaustion', () => {
    expect(detect('Context window limit reached for this session.')).toBe('Context window limit reached for this session.');
  });

  // -- non-matching cases --

  it('returns null for plain text with no prompt indicators', () => {
    expect(detect('Running tests...\nAll tests passed.')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(detect('')).toBeNull();
  });

  it('returns null for "permission required" diagnostic text without [y/n]', () => {
    expect(detect('Note: permission required to access /etc/shadow')).toBeNull();
  });

  it('returns null for quoted dialog text without a real [y/n] indicator', () => {
    expect(detect('The dialog asks: "Do you want to allow this extension to run?"\nInstallation complete.')).toBeNull();
  });

  // -- diff/code context filtering --

  it('returns null when prompt text appears in a diff removed line', () => {
    expect(detect('- Would you like to apply these changes? [y/n]\nDone.')).toBeNull();
  });

  it('returns null when prompt text appears in a diff added line', () => {
    expect(detect('+ Would you like to apply these changes? [y/n]\nDone.')).toBeNull();
  });

  it('returns null when prompt text appears in a diff hunk header context', () => {
    expect(detect('@@ -135,7 +135,7 @@ tool asking "Would you like to apply these changes? [y/n]"')).toBeNull();
  });

  it('returns null when prompt text appears in a numbered diff line', () => {
    expect(detect('135 -tool asking "Would you like to apply these changes? [y/n]"')).toBeNull();
  });

  it('still matches a real prompt even when diff lines precede it', () => {
    const text = '- old prompt line [y/n]\n+ new prompt line [y/n]\nApply patch? [y/n]';
    expect(detect(text)).toBe('Apply patch? [y/n]');
  });

  // -- recency window --

  it('returns null when prompt is buried beyond the recency window', () => {
    const lines = [
      'Would you like to proceed? [y/n]',
      'Line 2 after prompt',
      'Line 3 after prompt',
      'Line 4 after prompt',
      'Line 5 after prompt',
      'Line 6 after prompt',
      'All done.',
    ];
    expect(detect(lines.join('\n'))).toBeNull();
  });

  it('matches a prompt within the recency window', () => {
    const lines = [
      'Some earlier output',
      'More output',
      'Continue? [y/n]',
      'Line after prompt',
    ];
    expect(detect(lines.join('\n'))).toBe('Continue? [y/n]');
  });
});
