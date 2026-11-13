export interface FailureLocation { file: string; line: number; column: number }
/** The first stack frame of `error` outside node_modules, or null. */
export function failureLocation(error: unknown): FailureLocation | null;
/** The lines printed for one failure: file:line and title, the error and diff, and with `github` an `::error` annotation. */
export function formatFailure(options: { title: string; moduleId: string; error: unknown; root?: string; github?: boolean }): string;
/** Prints each failure as soon as its test or file fails, so a run that dies before its summary still shows them. */
export default class FailureReporter {
  constructor(options?: { github?: boolean; write?: (text: string) => void });
  onInit(vitest: { config: { root: string } }): void;
  onTestCaseResult(testCase: unknown): void;
  onTestModuleEnd(testModule: unknown): void;
}
