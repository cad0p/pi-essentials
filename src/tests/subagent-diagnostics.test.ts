import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFailureBody, STDERR_TAIL_BYTES } from "../subagent-diagnostics.ts";

describe("buildFailureBody", () => {
  it("returns fallback when all fields are empty", () => {
    const result = buildFailureBody({});
    assert.ok(result.includes("no diagnostic information captured"), result);
  });

  it("renders errorMessage", () => {
    const result = buildFailureBody({ errorMessage: "Rate limit exceeded" });
    assert.ok(result.includes("**Error:** Rate limit exceeded"), result);
  });

  it("renders status line with stopReason, exitCode, signal", () => {
    const result = buildFailureBody({ stopReason: "error", exitCode: 1, signal: "SIGTERM" });
    assert.ok(result.includes("**Status:**"), result);
    assert.ok(result.includes("stop=error"), result);
    assert.ok(result.includes("exit=1"), result);
    assert.ok(result.includes("signal=SIGTERM"), result);
  });

  it("omits status line when stopReason is end_turn and exitCode is 0", () => {
    const result = buildFailureBody({ stopReason: "end_turn", exitCode: 0 });
    assert.ok(!result.includes("**Status:**"), result);
  });

  it("renders stderr in a code block", () => {
    const result = buildFailureBody({ stderr: "some error output" });
    assert.ok(result.includes("**stderr:**"), result);
    assert.ok(result.includes("```"), result);
    assert.ok(result.includes("some error output"), result);
  });

  it("truncates long stderr to tail", () => {
    const longStderr = "x".repeat(STDERR_TAIL_BYTES + 500);
    const result = buildFailureBody({ stderr: longStderr });
    assert.ok(result.includes("truncated"), result);
    // Should contain the tail
    assert.ok(result.includes("x".repeat(100)), result);
  });

  it("renders lastToolCall", () => {
    const result = buildFailureBody({ lastToolCall: "$ ls /some/path" });
    assert.ok(result.includes("**Last activity:** $ ls /some/path"), result);
  });

  it("renders usageLine", () => {
    const result = buildFailureBody({ usageLine: "5t ↑100k ↓1k $0.05" });
    assert.ok(result.includes("**Usage before failure:** 5t ↑100k ↓1k $0.05"), result);
  });

  it("renders finalText as partial output", () => {
    const result = buildFailureBody({ finalText: "I was working on..." });
    assert.ok(result.includes("**Partial output:**"), result);
    assert.ok(result.includes("I was working on..."), result);
  });

  it("omits finalText when it is '(no output)'", () => {
    const result = buildFailureBody({ finalText: "(no output)" });
    assert.ok(!result.includes("**Partial output:**"), result);
  });

  it("omits empty fields silently", () => {
    const result = buildFailureBody({ errorMessage: "  ", stderr: "", lastToolCall: "" });
    assert.ok(!result.includes("**Error:**"), result);
    assert.ok(!result.includes("**stderr:**"), result);
    assert.ok(!result.includes("**Last activity:**"), result);
  });

  it("renders all fields together in correct order", () => {
    const result = buildFailureBody({
      errorMessage: "Err",
      stopReason: "aborted",
      exitCode: 1,
      signal: "SIGTERM",
      stderr: "stderr text",
      lastToolCall: "$ cmd",
      usageLine: "3t ↑50k",
      finalText: "partial",
    });
    const errIdx = result.indexOf("**Error:**");
    const statusIdx = result.indexOf("**Status:**");
    const stderrIdx = result.indexOf("**stderr:**");
    const activityIdx = result.indexOf("**Last activity:**");
    const usageIdx = result.indexOf("**Usage before failure:**");
    const outputIdx = result.indexOf("**Partial output:**");
    assert.ok(errIdx < statusIdx, "Error before Status");
    assert.ok(statusIdx < stderrIdx, "Status before stderr");
    assert.ok(stderrIdx < activityIdx, "stderr before Last activity");
    assert.ok(activityIdx < usageIdx, "Last activity before Usage");
    assert.ok(usageIdx < outputIdx, "Usage before Partial output");
  });
});
