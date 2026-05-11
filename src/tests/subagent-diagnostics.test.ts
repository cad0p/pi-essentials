import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildFailureBody,
  fenceFor,
  STDERR_TAIL_BYTES,
} from "../subagent-diagnostics.ts";

/**
 * Unit tests for the subagent failure-body formatter.
 *
 * Pure function, no peer-dep imports. Exercises the diagnostic fields
 * the upstream extension lost to "run.errorMessage || stderr || '(no output)'"
 * before the PR #X / fix/subagent-diagnostic-info branch.
 */

describe("buildFailureBody", () => {
  describe("fallback path", () => {
    it("empty input returns the explicit fallback, not an empty string", () => {
      const body = buildFailureBody({});
      assert.match(body, /no diagnostic information captured/);
      // The phrasing MUST surface that the failure info was lost — not
      // imply "(no output)" as if that were the subagent's own response.
      assert.doesNotMatch(body, /^\s*$/);
    });

    it("undefined/empty strings are treated as absent (don't render empty sections)", () => {
      const body = buildFailureBody({
        errorMessage: "",
        stopReason: undefined,
        stderr: "   ",
        lastToolCall: "",
        usageLine: "",
        finalText: "",
      });
      assert.match(body, /no diagnostic information captured/);
    });
  });

  describe("sections render only when relevant", () => {
    it("errorMessage renders as **Error:** line", () => {
      const body = buildFailureBody({ errorMessage: "Rate limit exceeded" });
      assert.match(body, /\*\*Error:\*\* Rate limit exceeded/);
    });

    it("status omits stopReason='end_turn' (normal completion)", () => {
      const body = buildFailureBody({ stopReason: "end_turn", exitCode: 1 });
      assert.doesNotMatch(body, /end_turn/);
      assert.match(body, /exit=1/);
    });

    it("status omits exitCode=0 (even on failure paths where signal is the real cause)", () => {
      const body = buildFailureBody({ exitCode: 0, signal: "SIGTERM" });
      assert.doesNotMatch(body, /exit=0/);
      assert.match(body, /signal=SIGTERM/);
    });

    it("status renders all non-trivial fields in one line", () => {
      const body = buildFailureBody({
        stopReason: "error",
        exitCode: 1,
        signal: "SIGTERM",
      });
      assert.match(body, /\*\*Status:\*\* stop=error, exit=1, signal=SIGTERM/);
    });

    it("stderr wraps in a fenced code block", () => {
      const body = buildFailureBody({
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
      const body = buildFailureBody({ stderr: head + mid + tail });
      assert.match(body, /TAIL_MARKER_SHOULD_REMAIN/);
      assert.doesNotMatch(body, /HEAD_MARKER_SHOULD_BE_GONE/);
      assert.match(body, /\(truncated; tail 2000 bytes\)/);
    });

    it("lastToolCall renders verbatim", () => {
      const body = buildFailureBody({ lastToolCall: "$ ls /some/path" });
      assert.match(body, /\*\*Last activity:\*\* \$ ls \/some\/path/);
    });

    it("usageLine renders verbatim", () => {
      const body = buildFailureBody({ usageLine: "5t ↑100k ↓1k $0.05" });
      assert.match(body, /\*\*Usage before failure:\*\* 5t ↑100k ↓1k \$0.05/);
    });

    it("finalText renders as partial output when non-empty", () => {
      const body = buildFailureBody({ finalText: "I was trying to help." });
      assert.match(body, /\*\*Partial output:\*\*/);
      assert.match(body, /I was trying to help\./);
    });

    it("finalText='(no output)' is suppressed — it's the subagent's own no-output marker, not useful context", () => {
      const body = buildFailureBody({ finalText: "(no output)" });
      assert.doesNotMatch(body, /Partial output/);
      assert.match(body, /no diagnostic information captured/);
    });
  });

  describe("composition", () => {
    it("full failure renders every section in stable order", () => {
      const body = buildFailureBody({
        errorMessage: "Rate limit exceeded",
        stopReason: "error",
        exitCode: 1,
        signal: "SIGTERM",
        stderr: "upstream returned 429",
        lastToolCall: "$ ls /x",
        usageLine: "5t ↑100k",
        finalText: "I was trying to help.",
      });

      // Order: Error → Status → stderr → Last activity → Usage → Partial output
      const iError = body.indexOf("**Error:**");
      const iStatus = body.indexOf("**Status:**");
      const iStderr = body.indexOf("**stderr:**");
      const iActivity = body.indexOf("**Last activity:**");
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
      const body = buildFailureBody({
        errorMessage: "err",
        lastToolCall: "$ x",
      });
      assert.match(body, /\*\*Error:\*\* err\n\n\*\*Last activity:\*\*/);
    });

    it("signal-kill with otherwise clean exit still surfaces the signal", () => {
      // Repro of the Real World failure mode that motivated this change:
      // pi -p's subprocess gets SIGTERM'd mid-run. exitCode is null (→ undefined
      // here), signal is SIGTERM, no errorMessage, empty stderr. Previously
      // rendered as literally "(no output)"; should now surface the signal.
      const body = buildFailureBody({
        signal: "SIGTERM",
        finalText: "Now I'll write the deliverable.",
      });
      assert.match(body, /signal=SIGTERM/);
      assert.match(body, /Now I'll write the deliverable\./);
    });

    it("thin-diagnostic case (only stopReason='aborted', nothing else) still fires a Status line", () => {
      const body = buildFailureBody({ stopReason: "aborted" });
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
