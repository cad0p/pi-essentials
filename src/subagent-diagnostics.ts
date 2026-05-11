/**
 * Diagnostic helpers for the subagent extension.
 *
 * Extracted into its own module so unit tests can import the pure
 * functions without dragging in the peer deps the main `subagent.ts`
 * needs (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`,
 * `@sinclair/typebox`). Keep this file free of peer-dep imports.
 */

/**
 * Shape of the diagnostic fields used to render a failure body.
 * Kept as a narrow input type so the formatter can be unit-tested
 * without constructing a full TrackedRun (which carries ChildProcess etc.).
 */
export interface FailureDiagnostics {
  errorMessage?: string;
  stopReason?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
  stderr?: string;
  lastToolCall?: string;
  usageLine?: string;
  finalText?: string;
}

/**
 * Max stderr bytes rendered into the failure body. Prevents a huge
 * stderr dump from drowning the parent agent's context. Tail-end is
 * kept because error traces usually appear at the bottom.
 */
export const STDERR_TAIL_BYTES = 2000;

/**
 * Render the body of a `## Subagent ... failed` message with all
 * diagnostic context available. Pure function — testable in isolation
 * (see `src/tests/subagent-diagnostics.test.ts`).
 *
 * Empty input fields are omitted. If NOTHING is known, returns a
 * clear "no diagnostic information captured" fallback — more useful
 * than silent emptiness because it tells the parent agent that the
 * harness itself lost the failure detail.
 */
export function buildFailureBody(d: FailureDiagnostics): string {
  const parts: string[] = [];

  if (d.errorMessage && d.errorMessage.trim()) {
    parts.push(`**Error:** ${d.errorMessage.trim()}`);
  }

  const meta: string[] = [];
  if (d.stopReason && d.stopReason !== "end_turn") meta.push(`stop=${d.stopReason}`);
  if (d.exitCode !== undefined && d.exitCode !== 0) meta.push(`exit=${d.exitCode}`);
  if (d.signal) meta.push(`signal=${d.signal}`);
  if (meta.length > 0) parts.push(`**Status:** ${meta.join(", ")}`);

  const stderrTrimmed = (d.stderr || "").trim();
  if (stderrTrimmed) {
    const tail =
      stderrTrimmed.length > STDERR_TAIL_BYTES
        ? `…(truncated; tail ${STDERR_TAIL_BYTES} bytes)\n${stderrTrimmed.slice(-STDERR_TAIL_BYTES)}`
        : stderrTrimmed;
    parts.push("**stderr:**\n\n```\n" + tail + "\n```");
  }

  if (d.lastToolCall && d.lastToolCall.trim()) {
    parts.push(`**Last activity:** ${d.lastToolCall.trim()}`);
  }

  if (d.usageLine && d.usageLine.trim()) {
    parts.push(`**Usage before failure:** ${d.usageLine.trim()}`);
  }

  const finalTextTrimmed = (d.finalText || "").trim();
  if (finalTextTrimmed && finalTextTrimmed !== "(no output)") {
    parts.push(`**Partial output:**\n\n${finalTextTrimmed}`);
  }

  return parts.length === 0
    ? "(no diagnostic information captured — the harness lost the failure detail)"
    : parts.join("\n\n");
}
