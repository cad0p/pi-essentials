/**
 * Context Pruner — lets the agent replace bulky tool results with short summaries.
 *
 * After reading search results, the agent calls `context_prune` with the
 * tool_use_id and a summary. On subsequent turns, the original content is
 * replaced with the summary, freeing context space.
 *
 * Uses the `context` event to swap content before it reaches the LLM,
 * same pattern as image-context-pruner.
 */
import type { ExtensionAPI, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type ToolResult = AgentToolResult<unknown>;
function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: {} };
}

const PRUNABLE_TOOLS = new Set([
  "knowledge_search",
  "session_search",
  "session_read",
  "graph_query",
  "graph_path",
  "code_search",
  "code_overview",
]);

const NUDGE = `
<context_management>
After processing results from search tools (knowledge_search, session_search, session_read, graph_query, code_search, code_overview), call context_prune to replace the bulky result with a short summary of what you extracted. This keeps the session lean. Prune aggressively — keep only facts you'll reference later. You can prune by tool name (prunes the most recent call to that tool) or by tool_use_id for precision.
</context_management>`;

export default function contextPruner(pi: ExtensionAPI) {
  const pruned = new Map<string, string>();
  // toolCallId → toolName
  const prunableCalls = new Map<string, string>();
  // toolName → most recent toolCallId (for prune-by-name)
  const latestByTool = new Map<string, string>();
  let hasPrunableTools = false;

  pi.on("session_start", async () => {
    pruned.clear();
    prunableCalls.clear();
    latestByTool.clear();
    hasPrunableTools = false;
  });

  pi.on("tool_execution_end", async (event) => {
    if (PRUNABLE_TOOLS.has(event.toolName)) {
      prunableCalls.set(event.toolCallId, event.toolName);
      latestByTool.set(event.toolName, event.toolCallId);
      hasPrunableTools = true;
    }
  });

  pi.on("context", async (event) => {
    if (pruned.size === 0) return;

    let replaced = 0;
    const messages = event.messages.map((msg: any) => {
      if (msg.role !== "toolResult") return msg;
      const summary = pruned.get(msg.toolCallId);
      if (!summary) return msg;
      replaced++;
      return {
        ...msg,
        content: [{ type: "text", text: `[pruned] ${summary}` }],
      };
    });

    if (replaced > 0) return { messages };
  });

  pi.on("before_agent_start", async (event) => {
    if (!hasPrunableTools) return;
    return { systemPrompt: event.systemPrompt + NUDGE };
  });

  pi.registerTool({
    name: "context_prune",
    description:
      "Replace a previous tool result with a short summary to free context space. " +
      "Use after processing results from search tools (knowledge_search, session_search, " +
      "graph_query, code_search, session_read, code_overview). Pass either the tool_use_id " +
      "or the tool_name (prunes the most recent call to that tool).",
    parameters: Type.Object({
      tool_use_id: Type.Optional(Type.String({ description: "tool_use_id of the result to replace" })),
      tool_name: Type.Optional(Type.String({ description: "Tool name — prunes the most recent call (e.g. 'knowledge_search')" })),
      summary: Type.String({ description: "Brief summary of useful content (1-3 sentences)" }),
    }),
    async execute(toolCallId: string, input: { tool_use_id?: string; tool_name?: string; summary: string }) {
      let { tool_use_id, tool_name, summary } = input;

      // Resolve tool_name to the most recent call ID
      if (!tool_use_id && tool_name) {
        tool_use_id = latestByTool.get(tool_name);
        if (!tool_use_id) return ok(`No recent ${tool_name} call found to prune.`);
      }
      if (!tool_use_id) return ok("Provide either tool_use_id or tool_name.");

      if (pruned.has(tool_use_id)) return ok(`Already pruned.`);

      pruned.set(tool_use_id, summary);
      const resolvedName = tool_name || prunableCalls.get(tool_use_id);
      const label = resolvedName ? ` (${resolvedName})` : "";

      return ok(`Pruned${label}. Summary replaces original on next turn.`);
    },
  });
}
