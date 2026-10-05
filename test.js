#!/usr/bin/env node

import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const client = new Client({ name: "smoke-client", version: "1.0.0" }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./index.js", import.meta.url))],
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["list_voices", "mute_speech", "queue_status", "speak", "stop_speech", "unmute_speech"]);
  const voices = await client.callTool({ name: "list_voices", arguments: {} });
  assert.notEqual(voices.isError, true, voices.content[0]?.text);
  assert.match(voices.content[0].text, /[a-z]{2}_[A-Z]{2}/);
  const invalid = await client.callTool({ name: "speak", arguments: { text: "test", rate: 0 } });
  assert.equal(invalid.isError, true);
  const speech = await client.callTool({ name: "speak", arguments: { text: "テストです。", rate: 200 } });
  assert.notEqual(speech.isError, true, speech.content[0]?.text);
  assert.match(speech.content[0].text, /速度: 200/);
  console.log("MCP接続・音声一覧・入力拒否・読み上げ受付を確認しました。再生完了や音質は検査していません。");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.close();
}
