#!/usr/bin/env node
// Agentry stdio MCP server. Runs in the user's Claude Code via stdio.
// Talks to the agentry API over HTTPS using the user's API key.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOL_DESCRIPTORS, dispatchTool } from "./tools.js";

async function main(): Promise<void> {
  const server = new Server(
    { name: "agentry", version: "0.0.1" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DESCRIPTORS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const result = await dispatchTool(name, args);
    // MCP content blocks: return a single JSON text block. Agents parse it.
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
      // If the result has a top-level `error`, signal that to the client too.
      isError: Boolean((result as { error?: unknown }).error),
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the process alive — connect() returns once the transport is ready,
  // not when it closes. The transport handles its own lifecycle on stdin EOF.
}

main().catch((err: unknown) => {
  // stderr is the only safe channel — stdout is the MCP protocol.
  // eslint-disable-next-line no-console
  console.error("[agentry-mcp] fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
