#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./src/server.js";

const { server, speech } = createServer();

async function shutdown() {
  speech.stop();
  await server.close();
}

process.once("SIGINT", () => shutdown().catch(console.error));
process.once("SIGTERM", () => shutdown().catch(console.error));
server.onclose = () => speech.stop();

server.connect(new StdioServerTransport()).then(() => {
  console.error("MCP Speak Server running on stdio");
}).catch((error) => {
  console.error("Fatal error:", error.message);
  speech.stop();
  process.exitCode = 1;
});
