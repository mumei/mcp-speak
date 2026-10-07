import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { validateObject } from "./speech.js";
import { createQueueSpeech } from "./queue-client.js";
import { AI_INSTRUCTIONS } from "./instructions.js";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export function createServer({ speech = createQueueSpeech() } = {}) {
  const server = new Server({ name: "mcp-speak", version }, {
    capabilities: { tools: {} },
    instructions: AI_INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "speak",
        description: "必要な完了報告・問題やユーザー判断・明示的な読み上げ依頼に、短い要点だけを共通FIFOへ送ります。通常はtextだけを渡し、voice・rateは省略してWebの共有設定を使ってください。ユーザーが声・速度の変更を求めた発話など、必要なときだけ明示指定でその発話を上書きできます。細かな途中経過・コード・生ログ・秘密情報・重複報告は読まないでください。応答は受付または破棄で、再生開始・完了を意味しません。",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1, description: "短い非秘密の要点。同じ内容を重複送信しない。UTF-8で64KiB以内" },
            voice: { type: "string", minLength: 1, description: "通常は省略してWebの共有設定を使用（未設定ならシステム既定）。ユーザーが特定の声を求めた発話など、必要時だけ利用可能な音声名を明示してその発話を上書き" },
            rate: { type: "integer", minimum: 1, maximum: 500, description: "1分あたりの単語数。通常は省略してWebの共有設定を使用（初期値175を毎回指定しない）。ユーザーが速度変更を求めた発話など、必要時だけ明示してその発話を上書き" },
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
      ...["queue_status", "stop_speech", "unmute_speech"].map((name) => ({
        name,
        description: {
          queue_status: "このMacの共有キューの状態・件数・ミュートモードを確認します",
          stop_speech: "このツールの共有再生と待機分を停止します。ミュート状態は変更しません",
          unmute_speech: "ユーザーの明示依頼でのみ共有ミュートを解除します。AIが勝手に解除しないでください。保留分は順番に再生します",
        }[name],
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      })),
      {
        name: "mute_speech",
        description: "ユーザーの依頼で共有キューをミュート・モード変更します。holdは保留、discardは破棄。現在の発声は停止し再キューしません。AIが勝手にモードを変更しないでください",
        inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["hold", "discard"] } }, required: ["mode"], additionalProperties: false },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === "speak") {
        const { text, voice, rate, jobId, queuePosition, discarded } = await speech.speak(args, { signal: extra.signal });
        if (discarded) return { content: [{ type: "text", text: "ミュートの破棄モードにより、この読み上げは破棄しました。" }] };
        return {
          content: [{
            type: "text",
            text: `音声読み上げを受け付けました: "${text}"${voice !== undefined ? `\n音声: ${voice}` : ""}\n速度: ${rate}${jobId ? `\n受付ID: ${jobId}\n受付時の順番: ${queuePosition}` : ""}\n再生完了はこの応答では確認できません。`,
          }],
        };
      }
      if (name === "list_voices") {
        validateObject(args === undefined ? {} : args, []);
        const voices = await speech.listVoices();
        return { content: [{ type: "text", text: `利用可能な音声:\n\n${voices}` }] };
      }
      const operations = { queue_status: "status", stop_speech: "stopQueue", unmute_speech: "unmute" };
      if (Object.hasOwn(operations, name)) {
        validateObject(args === undefined ? {} : args, []);
        const result = await speech[operations[name]]();
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      if (name === "mute_speech") {
        validateObject(args, ["mode"]);
        if (!["hold", "discard"].includes(args.mode)) throw new Error("modeはholdまたはdiscardを指定してください");
        return { content: [{ type: "text", text: JSON.stringify(await speech.mute(args.mode)) }] };
      }
      throw new Error(`未知のツール: ${name}`);
    } catch (error) {
      return { content: [{ type: "text", text: `エラー: ${error.message}` }], isError: true };
    }
  });

  return { server, speech };
}
