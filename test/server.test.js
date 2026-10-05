import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { createSpeech, validateSpeak } from "../src/speech.js";
import { AI_INSTRUCTIONS } from "../src/instructions.js";

async function withClient(speech, run) {
  const { server } = createServer({ speech });
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test("MCP exposes both tools and returns valid successful results", async () => {
  await withClient({
    speak: async (args) => validateSpeak(args),
    listVoices: async () => "Kyoko ja_JP # test",
  }, async (client) => {
    const tools = await client.listTools();
    assert.equal(client.getInstructions(), AI_INSTRUCTIONS);
    assert.match(client.getInstructions(), /自動発話を発生させません/);
    assert.match(client.getInstructions(), /秘密情報/);
    assert.match(client.getInstructions(), /AIの判断でunmute_speech/);
    assert.match(tools.tools[0].description, /受付または破棄/);
    assert.match(tools.tools[0].description, /重複報告/);
    assert.match(tools.tools.find((tool) => tool.name === "unmute_speech").description, /明示依頼/);
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["speak", "list_voices", "queue_status", "stop_speech", "unmute_speech", "mute_speech"]);
    const schema = tools.tools[0].inputSchema.properties.rate;
    assert.deepEqual([schema.minimum, schema.maximum, schema.default], [1, 500, 175]);
    const response = await client.callTool({ name: "speak", arguments: { text: "hello" } });
    assert.notEqual(response.isError, true);
    assert.match(response.content[0].text, /速度: 175/);
    assert.match(response.content[0].text, /再生完了/);
    const voices = await client.callTool({ name: "list_voices" });
    assert.notEqual(voices.isError, true);
    assert.match(voices.content[0].text, /Kyoko/);
  });
});

test("MCP reports invalid input and unknown tools using isError", async () => {
  await withClient({ speak: async (args) => validateSpeak(args) }, async (client) => {
    for (const params of [
      { name: "speak" },
      { name: "speak", arguments: { text: 123 } },
      { name: "speak", arguments: { text: "hello", rate: 0 } },
      { name: "list_voices", arguments: { unexpected: true } },
      { name: "unknown", arguments: {} },
    ]) {
      const response = await client.callTool(params);
      assert.equal(response.isError, true, JSON.stringify(params));
      assert.match(response.content[0].text, /^エラー:/);
    }
  });
});

test("asynchronous tool failures become MCP isError results", async () => {
  await withClient({
    speak: async () => { throw new Error("spawn ENOENT"); },
    listVoices: async () => { throw new Error("say unavailable"); },
  }, async (client) => {
    for (const name of ["speak", "list_voices"]) {
      const response = await client.callTool({ name, arguments: name === "speak" ? { text: "hello" } : {} });
      assert.equal(response.isError, true);
      assert.match(response.content[0].text, /ENOENT|unavailable/);
    }
  });
});

test("real child spawn failure crosses the MCP boundary as isError", async () => {
  const speech = createSpeech({ spawnProcess: (command, args, options) => spawn("/nonexistent/mcp-speak-review", args, options) });
  await withClient(speech, async (client) => {
    const response = await client.callTool({ name: "speak", arguments: { text: "hello" } });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /ENOENT/);
  });
});
