import { isPatchBaseDriftError } from '../patch/apply.js';
import type { VerifyResult } from '../verifier/index.js';

export function renderPatchPreview(preview: Array<{ path: string; type: string; summary: string; preview: string }>): string {
  return preview
    .map((item) => [`[${item.type}] ${item.path}`, item.summary, item.preview].join('\n'))
    .join('\n\n');
}

export function buildVerifierFailureMessage(verifyResult: VerifyResult): string {
  const blockingFailures = verifyResult.failures.filter((failure) => failure.blocking);
  const analysis = verifyResult.analysis;
  const details = blockingFailures.length > 0
    ? ` Failed commands: ${blockingFailures.map((failure) => failure.command).join('; ')}.`
    : '';
  const analysisText = analysis
    ? ` Analysis: ${analysis.summary || analysis.reason}${analysis.shouldEditVerifier ? ' Consider updating .marblecode/verifier.md.' : ''}`
    : '';
  return `Verifier failed after the maximum number of repair attempts.${details}${analysisText}`;
}

export function buildApplyFailureMessage(error: unknown, hadExplicitFiles: boolean, hadContext: boolean): string {
  const reason = error instanceof Error ? error.message : String(error);
  const hints: string[] = [];

  if (isPatchBaseDriftError(error)) {
    hints.push(`The baseline for ${error.filePath} changed after the patch was generated. Refresh context and regenerate the patch before retrying.`);
  }

  if (!hadExplicitFiles) {
    hints.push('No --file was provided. Try rerunning with --file path/to/file or --paste for a pasted snippet.');
  }

  if (!hadContext) {
    hints.push('No useful context was selected. Try a more specific prompt or provide a file explicitly.');
  }

  hints.push('You can inspect the session artifacts and use the rollback command if needed.');

  return [`Patch apply failed: ${reason}`, ...hints].join(' ');
}

export function buildProviderFailureMessage(error: unknown, retryAttempts: number): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Model request failed after ${retryAttempts} retries. ${reason}`;
}
