/**
 * orc-state — public API (semver-guarded; see docs/contracts.md → Public surface).
 *
 *   ControlClient, ControlError, CONTROL_PROTOCOL_VERSION — local control API client (protocol v1)
 *   createAdapter, assertAdapterContract  — provider adapter factory + contract check
 *   listProjects                          — registered projects with control socket + coordinator liveness
 *   validateAgents                        — agents.json validator (an authoritative file)
 *   validateEventObject                   — event schema validator
 *   getWorkerBootstrap/getMasterBootstrap — package bootstrap helpers
 *
 * The root, `./client` (client.ts: the side-effect-free client half) and `./schemas/*` are the only
 * package exports; every other module is internal.
 */
export { ControlClient } from './lib/controlClient.ts';
export type { ControlHealth } from './lib/controlServer.ts';
export type { CallOptions, ControlClientOptions, EventFilter, EventRow, OperatorResult, OperatorResults, RunDetail } from './lib/controlClient.ts';
export { CONTROL_PROTOCOL_VERSION, ControlError } from './lib/controlProtocol.ts';
export type {
  AckState, ControlEndpoint, ControlErrorBody, ControlErrorCode, ControlResponse,
  SessionTerminalView, StreamFrame, SubmitCommandRequest, TerminalFrame,
} from './lib/controlProtocol.ts';
export type { DurableCommand } from './lib/commandDelivery.ts';
export type { SemanticMessage, SendMessageInput } from './lib/messageRouter.ts';
export type { ControlSnapshot } from './lib/statusProjection.ts';
export type { ScoutSummary, SlotSummary, StatusView } from './lib/statusView.ts';
export type { TerminalRecord } from './lib/terminalBroker.ts';
export type { LifecycleRequest, LifecycleResult } from './lib/workerLifecycle.ts';
export type { OperatorOp, OperatorRequest } from './lib/operatorMutations.ts';
export type { ProjectTaskSummary, ProjectTaskView, TaskAuthoringInput } from './lib/projectTasks.ts';
export type { TaskRevisionSummary } from './lib/projectTaskStore.ts';
export type { PlanImportResult, TaskImportResult, TaskMarkdownSource } from './lib/taskMarkdown.ts';
export type { ScoutReportView } from './lib/scouts.ts';
export type { OrcEvent, ReviewSubmittedEvent } from './types/events.ts';

export { createAdapter, assertAdapterContract } from './adapters/index.ts';
export { listProjects } from './lib/projectList.ts';
export type { ProjectListEntry } from './lib/projectList.ts';
export { validateAgents } from './lib/stateValidation.ts';
export { validateEventObject } from './lib/eventValidation.ts';
export { getWorkerBootstrap, getMasterBootstrap } from './lib/sessionBootstrap.ts';
