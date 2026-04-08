export const TOOLS = [
  {
    name: 'list_tasks',
    description: 'List backlog tasks (summary view: ref, title, status, feature_ref, task_type, priority, owner, depends_on). By default excludes terminal tasks — pass status="done", "released", or "cancelled" to retrieve them. Use get_task(ref) for full detail including description and acceptance_criteria.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['todo', 'claimed', 'in_progress', 'done', 'blocked', 'released', 'cancelled'],
          description: 'Filter by task status',
        },
        feature: {
          type: 'string',
          description: 'Filter by feature ref (e.g. "project")',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_agents',
    description: 'List registered agents. Optionally filter by role. Dead agents are omitted unless include_dead=true.',
    inputSchema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          enum: ['worker', 'reviewer', 'master', 'scout'],
          description: 'Filter by agent role',
        },
        include_dead: {
          type: 'boolean',
          description: 'Include agents with status=dead (default: false)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_active_runs',
    description: 'List currently active task claims (claimed and in_progress).',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'list_stalled_runs',
    description: 'List active claims with no recent heartbeat.',
    inputSchema: {
      type: 'object',
      properties: {
        stale_after_ms: {
          type: 'integer',
          minimum: 0,
          description: 'Inactivity threshold in ms. Default: 600000 (10 min)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_task',
    description: 'Get a single task by ref. Returns { error: "not_found" } if absent.',
    inputSchema: {
      type: 'object',
      required: ['task_ref'],
      properties: {
        task_ref: {
          type: 'string',
          description: 'Full task ref, e.g. "project/feat-login"',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_recent_events',
    description: 'Return the most recent events from the SQLite events database. run_id is filtered server-side; agent_id matches both the agent_id column and the actor_id payload field.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 0,
          maximum: 200,
          description: 'Max events to return (default: 20, max: 200)',
        },
        agent_id: {
          type: 'string',
          description: 'Filter to events where agent_id or actor_id matches this value',
        },
        run_id: {
          type: 'string',
          description: 'Filter to events where run_id matches this value',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_status',
    description: 'Return compact aggregate status (agents, task counts, active tasks, last_notification_seq, stalled runs, next_task_seq).',
    inputSchema: {
      type: 'object',
      properties: {
        include_done_count: {
          type: 'boolean',
          description: 'Include terminal task counts, including done/released/cancelled (default: false)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_agent_workview',
    description: 'Return a compact actionable work summary for one agent.',
    inputSchema: {
      type: 'object',
      required: ['agent_id'],
      properties: {
        agent_id: {
          type: 'string',
          description: 'Agent to inspect',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_task',
    description: 'Register a task from an existing markdown backlog spec. Markdown-owned fields must already live in the spec.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        feature: {
          type: 'string',
          description: 'Feature ref. Defaults to "general" if omitted; the "general" feature is created automatically.',
        },
        title: { type: 'string', description: 'Task title; must match the markdown spec' },
        ref: { type: 'string', description: 'Explicit slug; must match the markdown spec if provided' },
        task_type: {
          type: 'string',
          enum: ['implementation', 'refactor'],
          description: 'Default: implementation',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'critical'],
          description: 'Default: normal',
        },
        required_capabilities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Native JSON array of capability strings — NOT a JSON-encoded string.',
        },
        required_provider: {
          type: 'string',
          enum: ['codex', 'claude', 'gemini'],
          description: 'Restrict dispatch to agents of this provider. Omit for any provider.',
        },
        owner: { type: 'string', description: 'Pre-assign to agent_id' },
        model: {
          type: ['string', 'null'],
          description: 'Model override for the worker session. Omit to use pool default.',
        },
        actor_id: { type: 'string', description: 'Defaults to master agent_id' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'update_task',
    description: 'Update runtime-owned mutable fields on an existing task. Markdown-authoritative fields are rejected.',
    inputSchema: {
      type: 'object',
      required: ['task_ref'],
      properties: {
        task_ref: {
          type: 'string',
          description: 'Full task ref, e.g. "orch/task-101-foo"',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'critical'],
          description: 'Replacement priority',
        },
        required_provider: {
          type: ['string', 'null'],
          enum: ['codex', 'claude', 'gemini', null],
          description: 'Set or clear the provider restriction. Pass null to remove.',
        },
        model: {
          type: ['string', 'null'],
          description: 'Model override for the worker session. Pass null to clear.',
        },
        actor_id: { type: 'string', description: 'Defaults to master agent_id' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'delegate_task',
    description: 'Assign a task to a worker. Auto-selects if target_agent_id omitted.',
    inputSchema: {
      type: 'object',
      required: ['task_ref'],
      properties: {
        task_ref: {
          type: 'string',
          description: 'Full task ref, e.g. "project/feat-login"',
        },
        target_agent_id: {
          type: 'string',
          description: 'Agent to assign to; auto-selects if omitted',
        },
        task_type: {
          type: 'string',
          enum: ['implementation', 'refactor'],
          description: 'Default: implementation',
        },
        note: {
          type: 'string',
          description: 'Optional note for delegation context',
        },
        actor_id: {
          type: 'string',
          description: 'Defaults to master agent_id',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'request_scout',
    description: 'Launch an on-demand investigation-only scout session. Scouts inspect code, logs, git history, runtime state, and optionally the web, then report findings without editing files or mutating orchestrator state.',
    inputSchema: {
      type: 'object',
      required: ['objective'],
      properties: {
        objective: {
          type: 'string',
          description: 'Investigation brief for the scout',
        },
        provider: {
          type: 'string',
          enum: ['codex', 'claude', 'gemini'],
          description: 'Provider for the scout session. Defaults to the requesting master provider.',
        },
        run_id: {
          type: 'string',
          description: 'Optional linked run id to investigate',
        },
        task_ref: {
          type: 'string',
          description: 'Optional linked task ref to investigate',
        },
        scope_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional file or directory paths the scout should prioritize',
        },
        use_web: {
          type: 'boolean',
          description: 'Whether the scout may use web research if the provider/session supports it',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_task',
    description: 'Cancel a task regardless of current non-terminal state. Blocks the task; active runs are cancelled and removed.',
    inputSchema: {
      type: 'object',
      required: ['task_ref'],
      properties: {
        task_ref: {
          type: 'string',
          description: 'Full task ref, e.g. "project/feat-login"',
        },
        reason: {
          type: 'string',
          description: 'Optional cancellation reason',
        },
        actor_id: {
          type: 'string',
          description: 'Defaults to master agent_id',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'respond_input',
    description: 'Respond to a worker input request for a specific run/agent pair.',
    inputSchema: {
      type: 'object',
      required: ['run_id', 'agent_id', 'response'],
      properties: {
        run_id: {
          type: 'string',
          description: 'Run waiting for input',
        },
        agent_id: {
          type: 'string',
          description: 'Worker agent waiting for input',
        },
        response: {
          type: 'string',
          description: 'Response text to send back to the waiting worker',
        },
        actor_id: {
          type: 'string',
          description: 'Defaults to the current master agent id',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_run',
    description: 'Get full details for a specific run by run_id. Returns claim object merged with task_title and worktree_path. Returns {error:"not_found"} if absent.',
    inputSchema: {
      type: 'object',
      required: ['run_id'],
      properties: {
        run_id: {
          type: 'string',
          description: 'Run ID to look up',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_waiting_input',
    description: 'List all claims currently awaiting worker input, with question text and wait time.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'query_events',
    description: 'Query the SQLite events database with optional filters. Returns last `limit` matching events.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'Filter by run_id',
        },
        agent_id: {
          type: 'string',
          description: 'Filter by agent_id',
        },
        event_type: {
          type: 'string',
          description: 'Filter by event type',
        },
        after_seq: {
          type: 'integer',
          minimum: 0,
          description: 'Only return events with seq > after_seq',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Maximum events to return (default: 50, max: 500)',
        },
        fts_query: {
          type: 'string',
          description: 'Full-text search query (FTS5 syntax) to match against event payloads',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reset_task',
    description: 'Reset a task to todo status, cancelling any active claims. Same logic as orc task-reset.',
    inputSchema: {
      type: 'object',
      required: ['task_ref'],
      properties: {
        task_ref: {
          type: 'string',
          description: 'Full task ref to reset',
        },
        actor_id: {
          type: 'string',
          description: 'Actor performing the reset (default: human)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_worktrees',
    description: 'List all registered run worktrees with agent, task, and path information.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_notifications',
    description: 'Poll for notification-class events (task completions, failures, cancellations, input requests) using a cursor. Returns events and a last_seq cursor for the next call. On startup, call with no after_seq to catch up on any missed events.',
    inputSchema: {
      type: 'object',
      properties: {
        after_seq: {
          type: 'integer',
          minimum: 0,
          description: 'Return events with seq > after_seq. Omit (or pass 0) on first call to retrieve all notification events.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_wake_up',
    description: 'Load essential memories for context. Returns formatted wake-up text grouped by wing/room.',
    inputSchema: {
      type: 'object',
      properties: {
        wing: {
          type: 'string',
          description: 'Filter to a specific wing (default: all wings)',
        },
        tokenBudget: {
          type: 'number',
          description: 'Approximate token budget for output (default: 800)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_recall',
    description: 'List drawers from a specific wing with optional room/limit filters.',
    inputSchema: {
      type: 'object',
      required: ['wing'],
      properties: {
        wing: {
          type: 'string',
          description: 'Wing to recall from',
        },
        room: {
          type: 'string',
          description: 'Filter to a specific room',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of drawers to return',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_search',
    description: 'Full-text search (FTS5) across memory drawers. Returns ranked snippets.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'FTS5 search query',
        },
        wing: {
          type: 'string',
          description: 'Filter results to a specific wing',
        },
        room: {
          type: 'string',
          description: 'Filter results to a specific room',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_store',
    description: 'Store a memory in a drawer and return its ID. Duplicate content (by hash) returns the existing ID.',
    inputSchema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: {
          type: 'string',
          description: 'Content to store',
        },
        wing: {
          type: 'string',
          description: 'Wing to store in (default: general)',
        },
        hall: {
          type: 'string',
          description: 'Hall to store in (default: default)',
        },
        room: {
          type: 'string',
          description: 'Room to store in (default: default)',
        },
        importance: {
          type: 'number',
          description: 'Importance score 1-10 (default: 5)',
        },
        sourceType: {
          type: 'string',
          description: 'Source type (e.g. agent, human)',
        },
        sourceRef: {
          type: 'string',
          description: 'Source reference identifier',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_status',
    description: 'Return memory statistics: total drawers, distinct wings/rooms, oldest/newest memory, and DB size.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];
