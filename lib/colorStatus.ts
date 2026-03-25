import chalk from 'chalk';
import {
  buildAgentStatus,
  buildStatus,
  formatAgentStatus,
  formatStatus,
} from './statusView.ts';

const HEADER_PATTERN = /^(Orchestrator Status|Master:|Worker Capacity:|Active Runs[^:]*:|Finalization[^:]*:|Recent Failures[^:]*:|Tasks[^:]*:|Agent Status:[^\n]*|Assigned Tasks[^:]*:|Queued Owned Tasks[^:]*:|Role:[^\n]*|Status:[^\n]*|Provider:[^\n]*)$/gm;
const POSITIVE_PATTERN = /\b(running|in_progress|attached|available)\b/g;
const WARNING_PATTERN = /\b(claimed|warming)\b/g;
const NEGATIVE_PATTERN = /\b(blocked|failed|unavailable|session_start_failed|run_failed)\b/g;
const COMPLETED_PATTERN = /\b(done|released|offline|cancelled)\b/g;

function applyColors(text: string): string {
  return text
    .replace(HEADER_PATTERN, (value) => chalk.bold.cyan(value))
    .replace(POSITIVE_PATTERN, (value) => chalk.green(value))
    .replace(WARNING_PATTERN, (value) => chalk.yellow(value))
    .replace(NEGATIVE_PATTERN, (value) => chalk.red(value))
    .replace(COMPLETED_PATTERN, (value) => chalk.gray(value));
}

export function colorFormatStatus(status: ReturnType<typeof buildStatus>): string {
  return applyColors(formatStatus(status));
}

export function colorFormatAgentStatus(
  status: ReturnType<typeof buildAgentStatus>,
  agentId: string,
): string {
  return applyColors(formatAgentStatus(status, agentId));
}
