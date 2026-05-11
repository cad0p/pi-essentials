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
  /** Pre-formatted usage string (e.g. "5t ↑100k ↓1k $0.05"). Passed as a
   *  string rather than a structured Usage object to keep this module free
   *  of the peer-dep imports that carry the Usage type. */
  usageLine?: string;
  /** Partial assistant text produced before the failure. Named 'partialOutput'
   *  to match the **Partial output:** section label shown to the reader. */
  partialOutput?: string;
}

/**
 * Max stderr bytes rendered into the failure body. Prevents a huge
 * stderr dump from drowning the parent agent's context. Tail-end is
 * kept because error traces usually appear at the bottom.
 */
export const STDERR_TAIL_BYTES = 2000;

/**
 * Choose a backtick-fence long enough that it cannot collide with any
 * run of backticks inside the content. CommonMark requires the opening
 * and closing fences to share length and for any backticks inside the
 * body to be shorter. A naked \`\`\` fence around stderr that itself
 * contains \`\`\` (rare but real — e.g. a stderr trace that quoted a
 * markdown snippet) splits the block in half and breaks the rendering
 * for every consumer downstream.
 *
 * Exported for test coverage of the fence-length logic.
 */
export function fenceFor(content: string): string {
  let longestRun = 0;
  let currentRun = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 96 /* backtick */) {
      currentRun++;
      if (currentRun > longestRun) longestRun = currentRun;
    } else {
      currentRun = 0;
    }
  }
  // Minimum fence is three backticks; otherwise one longer than the
  // longest inner run.
  return "`".repeat(Math.max(3, longestRun + 1));
}

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
export function formatFailureBody(d: FailureDiagnostics): string {
  const parts: string[] = [];

  if (d.errorMessage && d.errorMessage.trim()) {
    parts.push(`**Error:** ${d.errorMessage.trim()}`);
  }

  const meta: string[] = [];
  // Suppress "end_turn" — it signals normal completion, not a failure mode.
  if (d.stopReason && d.stopReason.trim() !== "end_turn") meta.push(`stop=${d.stopReason.trim()}`);
  if (d.exitCode !== undefined && d.exitCode !== 0) meta.push(`exit=${d.exitCode}`);
  if (d.signal) meta.push(`signal=${d.signal}`);
  if (meta.length > 0) parts.push(`**Status:** ${meta.join(", ")}`);

  const stderrTrimmed = (d.stderr || "").trim();
  if (stderrTrimmed) {
    const tail =
      stderrTrimmed.length > STDERR_TAIL_BYTES
        ? `…(truncated; tail ${STDERR_TAIL_BYTES} bytes)\n${stderrTrimmed.slice(-STDERR_TAIL_BYTES)}`
        : stderrTrimmed;
    const fence = fenceFor(tail);
    parts.push(`**stderr:**\n\n${fence}\n${tail}\n${fence}`);
  }

  if (d.lastToolCall && d.lastToolCall.trim()) {
    parts.push(`**Last activity:** ${d.lastToolCall.trim()}`);
  }

  if (d.usageLine && d.usageLine.trim()) {
    parts.push(`**Usage before failure:** ${d.usageLine.trim()}`);
  }

  const partialOutputTrimmed = (d.partialOutput || "").trim();
  if (partialOutputTrimmed && partialOutputTrimmed !== "(no output)") {
    parts.push(`**Partial output:**\n\n${partialOutputTrimmed}`);
  }

  return parts.length === 0
    ? "(no diagnostic information captured — check the post-mortem .jsonl)"
    : parts.join("\n\n");
}
