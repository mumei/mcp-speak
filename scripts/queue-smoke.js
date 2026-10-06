import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startWorker } from "../src/worker.js";

const directory = await fs.mkdtemp("/tmp/mcp-speak-real-smoke-");
const probe = net.createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const events = [];
const worker = await startWorker({ config: { directory, port }, onEvent: (event) => events.push(event) });
const clients = [];
try {
  for (let index = 0; index < 2; index++) {
    const client = new Client({ name: `real-smoke-${index}`, version: "1.0.0" }, { capabilities: {} });
    clients.push(client);
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../index.js", import.meta.url))],
      env: { ...process.env, MCP_SPEAK_WEB_AUTOSTART: "0", MCP_SPEAK_QUEUE_DIR: directory, MCP_SPEAK_QUEUE_PORT: String(port) },
      stderr: "pipe",
    }));
  }
  for (const [index, text] of ["一番です。", "二番です。"].entries()) {
    const result = await clients[index].callTool({ name: "speak", arguments: { text, rate: 250 } });
    assert.notEqual(result.isError, true, result.content[0]?.text);
  }
  const deadline = Date.now() + 30000;
  while (events.length < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(events.map((event) => event.type), ["start", "end", "start", "end"]);
  assert.ok(events.filter((event) => event.type === "end").every((event) => event.ok));
  assert.ok(events[2].time >= events[1].time);
  console.log("独立した2つのMCPプロセスから短い日本語を送り、実際のsayが重ならず順番に正常終了しました。音質は評価していません。");
} finally {
  for (const client of clients) await client.close();
  await worker.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.rm(directory, { recursive: true, force: true });
}
