// Opt-in local protocol smoke test. Prints event names and outcomes only.
// Usage: node scripts/vnext-provider-smoke.ts codex|claude
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const provider = process.argv[2];
if (provider !== 'codex' && provider !== 'claude') {
  throw new Error('Usage: node scripts/vnext-provider-smoke.ts codex|claude');
}

const env = { ...process.env };
for (const key of [
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AZURE_OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
]) delete env[key];

function log(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function start(binary: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(binary, args, { cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'] });
}

async function codexConnection(resumeThreadId?: string): Promise<{ threadId: string; events: string[]; turnStatus: string | undefined }> {
  const child = start(process.env.ORC_CODEX_SMOKE_BINARY ?? 'codex', ['app-server', '--listen', 'stdio://']);
  const events = new Set<string>();
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  let completed!: (status: string) => void;
  const completion = new Promise<string>((resolve) => { completed = resolve; });
  let stderrSeen = false;
  child.stderr.on('data', () => { stderrSeen = true; });
  child.on('error', (error) => { for (const entry of pending.values()) entry.reject(error); });
  child.on('exit', () => {
    for (const entry of pending.values()) entry.reject(new Error('Codex app-server exited before responding'));
    completed('process_exited');
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (typeof message.method === 'string') {
      events.add(message.method);
      if (message.method === 'turn/completed') {
        const params = message.params as { turn?: { status?: string } } | undefined;
        completed(params?.turn?.status ?? 'unknown');
      }
    }
    if (typeof message.id === 'number') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) {
        const error = message.error as { code?: number };
        entry.reject(new Error(`RPC ${message.id} failed with code ${error.code ?? 'unknown'}`));
      } else {
        entry.resolve((message.result ?? {}) as Record<string, unknown>);
      }
    }
  });
  const timer = setTimeout(() => {
    for (const entry of pending.values()) entry.reject(new Error('Codex app-server timed out'));
    completed('timeout');
    child.kill('SIGTERM');
  }, 90_000);
  const rpc = (id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = new Promise<Record<string, unknown>>((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return result;
  };
  try {
    await rpc(1, 'initialize', { clientInfo: { name: 'orc_state_smoke', title: 'orc-state protocol smoke', version: '0.1.0' } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const response = await rpc(2, resumeThreadId ? 'thread/resume' : 'thread/start',
      resumeThreadId ? { threadId: resumeThreadId, excludeTurns: true } : { cwd: process.cwd(), approvalPolicy: 'never', sandbox: 'read-only' });
    const threadId = (response.thread as { id?: string } | undefined)?.id;
    if (!threadId) throw new Error('No thread ID returned');
    let turnStatus: string | undefined;
    if (!resumeThreadId) {
      await rpc(3, 'turn/start', { threadId, input: [{ type: 'text', text: 'Reply with ORC_SMOKE_OK. Do not use tools.' }] });
      turnStatus = await completion;
    }
    log({ provider: 'codex', phase: resumeThreadId ? 'resume' : 'turn', events: [...events], turnStatus, stderrSeen });
    return { threadId, events: [...events], turnStatus };
  } finally {
    clearTimeout(timer);
    child.kill('SIGTERM');
  }
}

function errorCategory(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (/rate limit|usage limit|quota/i.test(value)) return 'quota';
  if (/auth|login|credential/i.test(value)) return 'authentication';
  if (/network|connection|timeout/i.test(value)) return 'network';
  if (/model|unavailable|overloaded/i.test(value)) return 'model_or_service';
  return 'other';
}

async function claudeTurn(sessionId: string, resume: boolean): Promise<{ events: string[]; result: string | undefined; isError: boolean; exitCode: number | null }> {
  const args = [
    '-p', resume ? 'Reply with ORC_RESUME_OK. Do not use tools.' : 'Reply with ORC_SMOKE_OK. Do not use tools.',
    '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config',
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
  ];
  const child = start(process.env.ORC_CLAUDE_SMOKE_BINARY ?? 'claude', args);
  const events = new Set<string>();
  let result: string | undefined;
  let isError = false;
  let failureCategory: string | undefined;
  let stderrSeen = false;
  child.stderr.on('data', () => { stderrSeen = true; });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (typeof message.type === 'string') events.add(message.type);
    if (message.type === 'result') {
      result = typeof message.subtype === 'string' ? message.subtype : 'unknown';
      isError = message.is_error === true;
      if (isError) failureCategory = errorCategory(message.result);
    }
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 90_000);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  clearTimeout(timer);
  log({ provider: 'claude', phase: resume ? 'resume' : 'turn', events: [...events], result, isError, failureCategory, exitCode, stderrSeen });
  return { events: [...events], result, isError, exitCode };
}

try {
  if (provider === 'codex') {
    const first = await codexConnection();
    if (first.turnStatus !== 'completed') throw new Error(`Codex turn status: ${first.turnStatus ?? 'unknown'}`);
    await codexConnection(first.threadId);
  } else {
    const sessionId = randomUUID();
    const first = await claudeTurn(sessionId, false);
    if (first.result !== 'success' || first.isError || first.exitCode !== 0) throw new Error('Claude turn did not complete successfully');
    const resumed = await claudeTurn(sessionId, true);
    if (resumed.result !== 'success' || resumed.isError || resumed.exitCode !== 0) throw new Error('Claude resume did not complete successfully');
  }
} catch (error) {
  log({ outcome: 'failed', reason: error instanceof Error ? error.message : 'unknown failure' });
  process.exitCode = 1;
}
