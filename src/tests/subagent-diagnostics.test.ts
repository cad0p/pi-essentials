import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildActivityTrail,
  DEFAULT_MAX_ACTIVITY_EVENTS,
  fenceFor,
  formatFailureBody,
  formatToolCallFull,
  MAX_ACTIVITY_LINE_CHARS,
  STDERR_TAIL_BYTES,
  type ToolCallEvent,
  truncateTail,
} from "../subagent-diagnostics.ts";

/**
 * Unit tests for the subagent failure-body formatter.
 *
 * Pure function, no peer-dep imports. Exercises the diagnostic fields
 * the upstream extension lost to "run.errorMessage || stderr || '(no output)'"
 * before the PR #X / fix/subagent-diagnostic-info branch.
 */

describe("formatFailureBody", () => {
  describe("fallback path", () => {
    it("empty input returns the explicit fallback, not an empty string", () => {
      const body = formatFailureBody({});
      assert.match(body, /no diagnostic information captured/);
      // The phrasing MUST surface that the failure info was lost — not
      // imply "(no output)" as if that were the subagent's own response.
      assert.doesNotMatch(body, /^\s*$/);
    });

    it("undefined/empty strings are treated as absent (don't render empty sections)", () => {
      const body = formatFailureBody({
        errorMessage: "",
        stopReason: undefined,
        stderr: "   ",
        activityTrail: "",
        usageLine: "",
        partialOutput: "",
      });
      assert.match(body, /no diagnostic information captured/);
    });
  });

  describe("sections render only when relevant", () => {
    it("errorMessage renders as **Error:** line", () => {
      const body = formatFailureBody({ errorMessage: "Rate limit exceeded" });
      assert.match(body, /\*\*Error:\*\* Rate limit exceeded/);
    });

    it("status omits stopReason='end_turn' (normal completion)", () => {
      const body = formatFailureBody({ stopReason: "end_turn", exitCode: 1 });
      assert.doesNotMatch(body, /end_turn/);
      assert.match(body, /\bexit=1\b/);
    });

    it("status omits exitCode=0 (even on failure paths where signal is the real cause)", () => {
      const body = formatFailureBody({ exitCode: 0, signal: "SIGTERM" });
      assert.doesNotMatch(body, /exit=0/);
      assert.match(body, /signal=SIGTERM/);
    });

    it("status renders all non-trivial fields in one line", () => {
      const body = formatFailureBody({
        stopReason: "error",
        exitCode: 1,
        signal: "SIGTERM",
      });
      assert.match(body, /\*\*Status:\*\* stop=error, exit=1, signal=SIGTERM/);
    });

    it("stderr wraps in a fenced code block", () => {
      const body = formatFailureBody({
        stderr: "something broke\nmore context",
      });
      assert.match(body, /\*\*stderr:\*\*/);
      assert.match(body, /```\nsomething broke\nmore context\n```/);
    });

    it("stderr gets truncated to tail when longer than STDERR_TAIL_BYTES", () => {
      // Fill with a repeating marker so we can assert head dropped, tail kept.
      const head = "HEAD_MARKER_SHOULD_BE_GONE\n";
      const mid = "x".repeat(STDERR_TAIL_BYTES);
      const tail = "\nTAIL_MARKER_SHOULD_REMAIN";
      const body = formatFailureBody({ stderr: head + mid + tail });
      assert.match(body, /TAIL_MARKER_SHOULD_REMAIN/);
      assert.doesNotMatch(body, /HEAD_MARKER_SHOULD_BE_GONE/);
      assert.match(body, /\(truncated; tail 2000 bytes\)/);
    });

    it("activityTrail renders verbatim as a markdown block", () => {
      const trail =
        "**Activity (2 tool calls):**\n\n- read: /some/path\n- bash: $ ls";
      const body = formatFailureBody({ activityTrail: trail });
      assert.match(body, /\*\*Activity \(2 tool calls\):\*\*/);
      assert.match(body, /- read: \/some\/path/);
      assert.match(body, /- bash: \$ ls/);
    });

    it("usageLine renders verbatim", () => {
      const body = formatFailureBody({ usageLine: "5t ↑100k ↓1k $0.05" });
      assert.match(body, /\*\*Usage before failure:\*\* 5t ↑100k ↓1k \$0.05/);
    });

    it("finalText renders as partial output when non-empty", () => {
      const body = formatFailureBody({ partialOutput: "I was trying to help." });
      assert.match(body, /\*\*Partial output:\*\*/);
      assert.match(body, /I was trying to help\./);
    });

    it("finalText='(no output)' is suppressed — it's the subagent's own no-output marker, not useful context", () => {
      const body = formatFailureBody({ partialOutput: "(no output)" });
      assert.doesNotMatch(body, /Partial output/);
      assert.match(body, /no diagnostic information captured/);
    });
  });

  describe("composition", () => {
    it("full failure renders every section in stable order", () => {
      const body = formatFailureBody({
        errorMessage: "Rate limit exceeded",
        stopReason: "error",
        exitCode: 1,
        signal: "SIGTERM",
        stderr: "upstream returned 429",
        activityTrail: "**Activity (1 tool call):**\n\n- bash: $ ls /x",
        usageLine: "5t ↑100k",
        partialOutput: "I was trying to help.",
      });

      // Order: Error → Status → stderr → Activity → Usage → Partial output
      const iError = body.indexOf("**Error:**");
      const iStatus = body.indexOf("**Status:**");
      const iStderr = body.indexOf("**stderr:**");
      const iActivity = body.indexOf("**Activity (");
      const iUsage = body.indexOf("**Usage before failure:**");
      const iPartial = body.indexOf("**Partial output:**");

      assert.ok(iError >= 0, "error section present");
      assert.ok(iStatus > iError, "status after error");
      assert.ok(iStderr > iStatus, "stderr after status");
      assert.ok(iActivity > iStderr, "activity after stderr");
      assert.ok(iUsage > iActivity, "usage after activity");
      assert.ok(iPartial > iUsage, "partial output after usage");
    });

    it("sections are separated by blank lines (render as discrete markdown blocks)", () => {
      const body = formatFailureBody({
        errorMessage: "err",
        activityTrail: "**Activity (1 tool call):**\n\n- bash: $ x",
      });
      assert.match(body, /\*\*Error:\*\* err\n\n\*\*Activity \(/);
    });

    it("signal-kill with otherwise clean exit still surfaces the signal", () => {
      // Repro of the Real World failure mode that motivated this change:
      // pi -p's subprocess gets SIGTERM'd mid-run. exitCode is null (→ undefined
      // here), signal is SIGTERM, no errorMessage, empty stderr. Previously
      // rendered as literally "(no output)"; should now surface the signal.
      const body = formatFailureBody({
        signal: "SIGTERM",
        partialOutput: "Now I'll write the deliverable.",
      });
      assert.match(body, /signal=SIGTERM/);
      assert.match(body, /Now I'll write the deliverable\./);
    });

    it("thin-diagnostic case (only stopReason='aborted', nothing else) still fires a Status line", () => {
      const body = formatFailureBody({ stopReason: "aborted" });
      assert.match(body, /\*\*Status:\*\* stop=aborted/);
      assert.doesNotMatch(body, /no diagnostic information captured/);
    });
  });
});

describe("fenceFor", () => {
  it("default fence is 3 backticks when content has none", () => {
    assert.equal(fenceFor("plain text\nno backticks"), "```");
  });

  it("single backtick in content still allows 3-backtick fence", () => {
    assert.equal(fenceFor("has one ` inside"), "```");
  });

  it("double backtick in content still allows 3-backtick fence", () => {
    assert.equal(fenceFor("has two `` inside"), "```");
  });

  it("triple backtick in content forces 4-backtick fence", () => {
    assert.equal(fenceFor("has three ``` inside"), "````");
  });

  it("backtick runs are counted correctly across whitespace (non-contiguous runs don't aggregate)", () => {
    // Two separate runs of 2 backticks — longest run is 2, fence is 3.
    assert.equal(fenceFor("run 1: `` and run 2: ``"), "```");
  });

  it("very long run of backticks picks fence one longer", () => {
    const content = "`".repeat(10);
    assert.equal(fenceFor(content), "`".repeat(11));
  });
});

describe("truncateTail", () => {
  it("short strings pass through unchanged", () => {
    assert.equal(truncateTail("hello", 100), "hello");
  });

  it("exact-length string is not truncated", () => {
    const s = "a".repeat(256);
    assert.equal(truncateTail(s, 256), s);
  });

  it("long string is tail-stripped with '…(N chars truncated)' suffix", () => {
    const s = "a".repeat(300);
    const out = truncateTail(s, 256);
    assert.match(out, /…\(\d+ chars truncated\)$/);
    assert.ok(out.length <= 256, "output length never exceeds maxChars");
  });

  it("reports the correct truncated-byte count in the suffix", () => {
    const s = "a".repeat(500);
    const out = truncateTail(s, 100);
    assert.match(out, /…\(400 chars truncated\)$/);
  });

  it("head is preserved verbatim (tail is the cheap loss)", () => {
    const head = "IDENTIFYING_PREFIX ";
    const tail = "x".repeat(500);
    const out = truncateTail(head + tail, 100);
    assert.ok(out.startsWith(head), "identifying prefix is intact");
  });
});

describe("formatToolCallFull", () => {
  it("bash renders as '- bash: $ <full command>'", () => {
    const event: ToolCallEvent = {
      name: "bash",
      arguments: { command: "ls -la /foo" },
    };
    assert.equal(formatToolCallFull(event), "- bash: $ ls -la /foo");
  });

  it("read/write/edit render with full file_path, no home-tilde collapse", () => {
    const longPath =
      "/local/home/someone/workplace/deeply/nested/project/src/file.ts";
    for (const name of ["read", "write", "edit"]) {
      const event: ToolCallEvent = {
        name,
        arguments: { file_path: longPath },
      };
      const out = formatToolCallFull(event);
      assert.equal(out, `- ${name}: ${longPath}`);
      assert.doesNotMatch(out, /^\s*- \w+: ~/, "no ~ collapse");
    }
  });

  it("falls back to `path` if `file_path` is absent (legacy key)", () => {
    const event: ToolCallEvent = {
      name: "read",
      arguments: { path: "/legacy/path.txt" },
    };
    assert.equal(formatToolCallFull(event), "- read: /legacy/path.txt");
  });

  it("grep renders pattern + search path", () => {
    const event: ToolCallEvent = {
      name: "grep",
      arguments: { pattern: "needle", path: "/haystack" },
    };
    assert.equal(formatToolCallFull(event), "- grep: needle in /haystack");
  });

  it("grep defaults to '.' when no path is given", () => {
    const event: ToolCallEvent = {
      name: "grep",
      arguments: { pattern: "x" },
    };
    assert.equal(formatToolCallFull(event), "- grep: x in .");
  });

  it("unknown tools render their args as compact JSON", () => {
    const event: ToolCallEvent = {
      name: "custom-thing",
      arguments: { foo: "bar", n: 42 },
    };
    const out = formatToolCallFull(event);
    assert.match(out, /^- custom-thing: /);
    assert.match(out, /"foo":"bar"/);
  });

  it("truncates at MAX_ACTIVITY_LINE_CHARS (256) by default", () => {
    const longCmd = "a".repeat(500);
    const event: ToolCallEvent = {
      name: "bash",
      arguments: { command: longCmd },
    };
    const out = formatToolCallFull(event);
    assert.ok(out.length <= MAX_ACTIVITY_LINE_CHARS,
      `line length ${out.length} exceeds cap ${MAX_ACTIVITY_LINE_CHARS}`);
    assert.match(out, /…\(\d+ chars truncated\)$/);
  });

  it("accepts a custom maxLineChars override", () => {
    const event: ToolCallEvent = {
      name: "bash",
      arguments: { command: "a".repeat(200) },
    };
    const out = formatToolCallFull(event, 50);
    assert.ok(out.length <= 50);
  });
});

describe("buildActivityTrail", () => {
  const mkBash = (cmd: string): ToolCallEvent => ({
    name: "bash",
    arguments: { command: cmd },
  });
  const mkRead = (path: string): ToolCallEvent => ({
    name: "read",
    arguments: { file_path: path },
  });

  it("returns empty string on empty input (caller can guard and omit)", () => {
    assert.equal(buildActivityTrail([]), "");
  });

  it("renders single-event trail with 'N tool call' header (singular)", () => {
    const out = buildActivityTrail([mkBash("ls")]);
    assert.match(out, /\*\*Activity \(1 tool call\):\*\*/);
    assert.match(out, /- bash: \$ ls/);
  });

  it("renders multi-event trail with 'N tool calls' header (plural)", () => {
    const out = buildActivityTrail([mkBash("ls"), mkRead("/foo")]);
    assert.match(out, /\*\*Activity \(2 tool calls\):\*\*/);
  });

  it("preserves chronological order (oldest first in the shown window)", () => {
    const events = [mkBash("first"), mkBash("second"), mkBash("third")];
    const out = buildActivityTrail(events);
    const iFirst = out.indexOf("first");
    const iSecond = out.indexOf("second");
    const iThird = out.indexOf("third");
    assert.ok(iFirst >= 0 && iSecond > iFirst && iThird > iSecond);
  });

  it("caps at DEFAULT_MAX_ACTIVITY_EVENTS, showing the most recent N", () => {
    const many: ToolCallEvent[] = Array.from(
      { length: DEFAULT_MAX_ACTIVITY_EVENTS + 5 },
      (_, i) => mkBash(`cmd-${i}`),
    );
    const out = buildActivityTrail(many);
    // Oldest events elided
    assert.doesNotMatch(out, /cmd-0\b/);
    assert.doesNotMatch(out, /cmd-4\b/);
    // Recent events kept
    assert.match(out, /cmd-24\b/);
    // Header reports the elision
    assert.match(out, /showing last 20/);
    assert.match(out, /5 older elided/);
  });

  it("when eventsFile is provided and events are elided, points reader at the file", () => {
    const many = Array.from({ length: 25 }, (_, i) => mkBash(`cmd-${i}`));
    const out = buildActivityTrail(many, {
      eventsFile: "/tmp/subagent-xyz-events.jsonl",
    });
    assert.match(out, /older 5 in \/tmp\/subagent-xyz-events\.jsonl/);
  });

  it("when eventsFile is provided but nothing is elided, still points at the file for truncation-recovery", () => {
    const out = buildActivityTrail([mkBash("ls")], {
      eventsFile: "/tmp/subagent-xyz-events.jsonl",
    });
    assert.match(out, /full events in \/tmp\/subagent-xyz-events\.jsonl/);
  });

  it("respects a custom maxEvents override", () => {
    const events = [mkBash("a"), mkBash("b"), mkBash("c"), mkBash("d")];
    const out = buildActivityTrail(events, { maxEvents: 2 });
    assert.match(out, /showing last 2/);
    assert.match(out, /2 older elided/);
    assert.match(out, /- bash: \$ c/);
    assert.match(out, /- bash: \$ d/);
    assert.doesNotMatch(out, /- bash: \$ a\b/);
  });

  it("truncates per-line at the configured maxLineChars", () => {
    const events = [mkBash("a".repeat(500))];
    const out = buildActivityTrail(events, { maxLineChars: 100 });
    const lines = out.split("\n").filter((l) => l.startsWith("- "));
    for (const line of lines) {
      assert.ok(line.length <= 100, `line exceeds cap: ${line.length}`);
    }
  });
});
