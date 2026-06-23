#!/usr/bin/env node

const SERVER_VERSION = "0.0.26";

const LINKS = {
  install: "https://agentry.sh/install.md",
  reference: "https://agentry.sh/agentry.md",
  skill: "https://agentry.sh/skill/agentry/SKILL.md",
  discovery: "https://api.agentry.sh/",
  openapi: "https://api.agentry.sh/v1/openapi.json",
  adapters: "https://api.agentry.sh/adapters"
};

const SKILL_HANDOFF_TEXT = `Agentry is agent-native analytics and logging for coding agents: product analytics, error logging, and deploy attribution over one HTTP API.

Canonical Agentry skill:
${LINKS.skill}

Load or install that skill before doing Agentry work. The skill is the agent instruction layer; it routes setup to the canonical install flow and routes post-setup questions to the daily-use reference.

When the skill is loaded:
- Setup/install requests route to ${LINKS.install}
- Product, reliability, case, analytics, or deploy questions after setup route to ${LINKS.reference}
- Exact API shapes come from ${LINKS.openapi}

Source of truth:
- Skill: ${LINKS.skill}
- Install: ${LINKS.install}
- Daily use: ${LINKS.reference}
- API discovery: ${LINKS.discovery}
- OpenAPI: ${LINKS.openapi}

This MCP server does not perform auth, install Agentry, ingest telemetry, query Agentry, proxy the API, or replace the skill.`;

const RESOURCES = [
  {
    uri: "agentry://skill",
    name: "Agentry skill handoff",
    description: "Canonical Agentry skill handoff for agent-native analytics, logging, and deploy attribution.",
    mimeType: "text/markdown",
    text: SKILL_HANDOFF_TEXT
  },
  {
    uri: "agentry://links",
    name: "Agentry canonical links",
    description: "Canonical Agentry docs and API links.",
    mimeType: "application/json",
    text: JSON.stringify(LINKS, null, 2)
  }
];

const TOOLS = [
  {
    name: "get_agentry_skill",
    description: "Returns the canonical Agentry skill handoff. Relevant when the user asks for Agentry, analytics, logging, error monitoring, product telemetry, deploy attribution, or production debugging. This tool only points to the skill; it does not install anything or call the Agentry API.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  }
];

const PROMPTS = [
  {
    name: "use_agentry_skill",
    description: "Load or install the canonical Agentry skill before doing Agentry setup or daily-use work."
  }
];

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  write({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function textContent(text) {
  return { content: [{ type: "text", text }] };
}

function promptMessage(text) {
  return {
    messages: [
      {
        role: "user",
        content: { type: "text", text }
      }
    ]
  };
}

function handleRequest(request) {
  const { id, method, params } = request;

  if (!method || method.startsWith("notifications/")) {
    return;
  }

  switch (method) {
    case "initialize":
      result(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: {
          tools: {},
          resources: {},
          prompts: {}
        },
        serverInfo: {
          name: "agentry-mcp",
          version: SERVER_VERSION
        }
      });
      return;

    case "tools/list":
      result(id, { tools: TOOLS });
      return;

    case "tools/call":
      if (params?.name === "get_agentry_skill") {
        result(id, textContent(SKILL_HANDOFF_TEXT));
        return;
      }
      error(id, -32602, `Unknown tool: ${params?.name || "(missing)"}`);
      return;

    case "resources/list":
      result(id, {
        resources: RESOURCES.map(({ text, ...resource }) => resource)
      });
      return;

    case "resources/read": {
      const resource = RESOURCES.find((item) => item.uri === params?.uri);
      if (!resource) {
        error(id, -32602, `Unknown resource: ${params?.uri || "(missing)"}`);
        return;
      }
      result(id, {
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType,
            text: resource.text
          }
        ]
      });
      return;
    }

    case "prompts/list":
      result(id, { prompts: PROMPTS });
      return;

    case "prompts/get":
      if (params?.name === "use_agentry_skill") {
        result(id, promptMessage(`Load or install the canonical Agentry skill from ${LINKS.skill}. Follow the skill for Agentry setup and daily-use work.`));
        return;
      }
      error(id, -32602, `Unknown prompt: ${params?.name || "(missing)"}`);
      return;

    default:
      error(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf("\n");

  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);

    if (line) {
      try {
        handleRequest(JSON.parse(line));
      } catch (parseError) {
        error(null, -32700, `Parse error: ${parseError.message}`);
      }
    }

    newlineIndex = buffer.indexOf("\n");
  }
});
