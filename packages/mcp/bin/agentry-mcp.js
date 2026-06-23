#!/usr/bin/env node

const SERVER_VERSION = "0.0.23";

const LINKS = {
  install: "https://agentry.sh/install.md",
  reference: "https://agentry.sh/agentry.md",
  skill: "https://agentry.sh/skill/agentry/SKILL.md",
  discovery: "https://api.agentry.sh/",
  openapi: "https://api.agentry.sh/v1/openapi.json",
  adapters: "https://api.agentry.sh/adapters"
};

const INSTALL_TEXT = `Agentry is agent-native analytics and logging for coding agents: product analytics, error logging, and deploy attribution over one HTTP API.

Install Agentry by fetching ${LINKS.install} and following it exactly.

Do not summarize the install doc back to the user. Proceed with the install flow from that document:
resolve auth/project, inspect the repo, call the Agentry install planner, present the planner's approval message, wait for approval, save the signal map, instrument the approved signals, save the implementation report, and verify with Agentry before claiming success.

Source of truth:
- Install: ${LINKS.install}
- Skill: ${LINKS.skill}
- API discovery: ${LINKS.discovery}
- OpenAPI: ${LINKS.openapi}`;

const DAILY_TEXT = `Agentry gives coding agents production context for cases, analytics, and deploys.

Use Agentry by fetching ${LINKS.reference} and following the day-to-day read model there.

Start from the saved signal map, latest verify report, answer contracts, event names, and property keys. Then use cases, analytics, deploys, query blueprints, or custom HogQL only when the needed telemetry exists.

Source of truth:
- Daily use: ${LINKS.reference}
- API discovery: ${LINKS.discovery}
- OpenAPI: ${LINKS.openapi}`;

const RESOURCES = [
  {
    uri: "agentry://install",
    name: "Agentry install pointer",
    description: "Canonical install handoff for agent-led analytics, logging, error monitoring, and deploy attribution.",
    mimeType: "text/markdown",
    text: INSTALL_TEXT
  },
  {
    uri: "agentry://daily-use",
    name: "Agentry daily-use pointer",
    description: "Canonical post-install handoff for reading Agentry cases, analytics, deploys, and signal maps.",
    mimeType: "text/markdown",
    text: DAILY_TEXT
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
    name: "start_agentry_install",
    description: "Canonical install handoff for Agentry, the agent-native analytics, logging, and deploy attribution API. Relevant to analytics, telemetry, logging, error monitoring, production debugging, and deploy attribution. Returns instructions to follow https://agentry.sh/install.md.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "start_agentry_daily_use",
    description: "Canonical post-install handoff for Agentry daily use. Returns instructions for reading cases, analytics, deploys, event names, query blueprints, and saved signal maps from https://agentry.sh/agentry.md.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  }
];

const PROMPTS = [
  {
    name: "install_agentry",
    description: "Install Agentry through the canonical agent-led install document."
  },
  {
    name: "use_agentry",
    description: "Answer production, product, reliability, or deploy questions using the canonical Agentry daily-use document."
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
      if (params?.name === "start_agentry_install") {
        result(id, textContent(INSTALL_TEXT));
        return;
      }
      if (params?.name === "start_agentry_daily_use") {
        result(id, textContent(DAILY_TEXT));
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
      if (params?.name === "install_agentry") {
        result(id, promptMessage(`Install Agentry in this repo for agent-native analytics, logging, and deploy attribution. Fetch ${LINKS.install} and proceed exactly from that document.`));
        return;
      }
      if (params?.name === "use_agentry") {
        result(id, promptMessage(`Use Agentry to answer my production, product, reliability, or deploy question. Fetch ${LINKS.reference} and proceed from that document.`));
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
