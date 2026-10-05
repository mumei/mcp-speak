import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createSpeech, validateObject } from "./speech.js";

export function createServer({ speech = createSpeech() } = {}) {
  const server = new Server({ name: "mcp-speak", version: "1.0.0" }, {
    capabilities: { tools: {} },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "speak",
        description: "macOSのsayでテキストを読み上げます。応答は再生完了を保証しません。",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1, description: "読み上げるテキスト" },
            voice: { type: "string", minLength: 1, description: "利用可能な音声名。省略時はシステム既定" },
            rate: { type: "integer", minimum: 1, maximum: 500, default: 175, description: "1分あたりの単語数" },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
      {
        name: "list_voices",
        description: "このMacで利用可能な音声一覧を取得します",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === "speak") {
        const { text, voice, rate } = await speech.speak(args);
        return {
          content: [{
            type: "text",
            text: `音声読み上げを受け付けました: "${text}"${voice !== undefined ? `\n音声: ${voice}` : ""}\n速度: ${rate}\n再生完了はこの応答では確認できません。`,
          }],
        };
      }
      if (name === "list_voices") {
        validateObject(args === undefined ? {} : args, []);
        const voices = await speech.listVoices();
        return { content: [{ type: "text", text: `利用可能な音声:\n\n${voices}` }] };
      }
      throw new Error(`未知のツール: ${name}`);
    } catch (error) {
      return { content: [{ type: "text", text: `エラー: ${error.message}` }], isError: true };
    }
  });

  return { server, speech };
}
