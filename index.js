#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./src/server.js";
import { holdWeb } from "./src/web-runtime.js";

const { server, speech } = createServer();
const web = process.env.MCP_SPEAK_WEB_AUTOSTART === "0" ? null : holdWeb({ log: console.error });
web?.ready.catch(() => {});

async function shutdown() {
  speech.stop();
  web?.stop();
  await server.close();
}

process.once("SIGINT", () => shutdown().catch(console.error));
process.once("SIGTERM", () => shutdown().catch(console.error));
server.onclose = () => { speech.stop(); web?.stop(); };
process.stdin.once("end", () => shutdown().catch(console.error));

server.connect(new StdioServerTransport()).then(() => {
  console.error("MCP Speak Server running on stdio");
}).catch((error) => {
  console.error("Fatal error:", error.message);
  speech.stop();
  web?.stop();
  process.exitCode = 1;
});
