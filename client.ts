/**
 * orc-state/client — the entry an app or TUI imports (semver-guarded; see docs/contracts.md → Public surface).
 *
 *   ControlClient, ControlError, CONTROL_PROTOCOL_VERSION — local control API client (protocol v1)
 *   listProjects, RegistrySchemaError     — registered projects with control socket + coordinator liveness
 *
 * Importing it has no side effects (no project resolution, registry access,
 * git calls or environment checks) and its module graph uses Node built-ins
 * only: no native modules. `listProjects` reads registry.db with node:sqlite.
 * The root entry (`orc-state`) is the full runtime and resolves the active
 * project when imported.
 */
export { ControlClient } from './lib/controlClient.ts';
export type { ControlHealth } from './lib/controlServer.ts';
export type { ControlClientOptions, EventFilter, EventRow, OperatorResult, OperatorResults, RunDetail } from './lib/controlClient.ts';
export { CONTROL_PROTOCOL_VERSION, ControlError } from './lib/controlProtocol.ts';
export type {
  AckState, ControlEndpoint, ControlErrorBody, ControlErrorCode, ControlResponse,
  SessionTerminalView, StreamFrame, SubmitCommandRequest, TerminalFrame,
} from './lib/controlProtocol.ts';
export type { DurableCommand } from './lib/commandDelivery.ts';
export type { SemanticMessage, SendMessageInput } from './lib/messageRouter.ts';
export type { ControlSnapshot } from './lib/statusProjection.ts';
export type { RunListRow, RunListState } from './lib/runList.ts';
export type { ScoutSummary, SlotSummary, StatusView } from './lib/statusView.ts';
export type { TerminalRecord } from './lib/terminalBroker.ts';
export type { LifecycleRequest, LifecycleResult } from './lib/workerLifecycle.ts';
export type { OperatorOp, OperatorRequest } from './lib/operatorMutations.ts';
export type { ProjectTaskSummary, ProjectTaskView, TaskAuthoringInput } from './lib/projectTasks.ts';
export type { TaskRevisionSummary } from './lib/projectTaskStore.ts';
export type { PlanImportResult, TaskImportResult, TaskMarkdownSource } from './lib/taskMarkdown.ts';
export type { ScoutReportView } from './lib/scouts.ts';
export type { OrcEvent, ReviewSubmittedEvent } from './types/events.ts';

export { listProjects, RegistrySchemaError } from './lib/projectList.ts';
export type { ProjectListEntry } from './lib/projectList.ts';
