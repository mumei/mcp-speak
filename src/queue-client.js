import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { prepareConfig, queueConfig, readMessages, send, MAX_TEXT_BYTES } from "./queue-config.js";
import { createSpeech, validateSpeak } from "./speech.js";

export function createQueueSpeech({ config = queueConfig(), autostart = true, log = console.error } = {}) {
  let socket;
  let connecting;
  let closed = false;
  const pending = new Map();
  const local = createSpeech();
  async function connect() {
    if (closed) throw new Error("このMCP接続は終了しています");
    if (socket && !socket.destroyed) return;
    if (connecting) return connecting;
    connecting = (async () => {
      const prepared = await prepareConfig(config);
      let launched = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (closed) throw new Error("このMCP接続は終了しています");
        try {
          const candidate = await new Promise((resolve, reject) => {
            const stream = net.createConnection({ host: "127.0.0.1", port: prepared.port });
            const timer = setTimeout(() => stream.destroy(new Error("ワーカー接続がタイムアウトしました")), 1000);
            stream.once("error", reject);
            stream.once("connect", () => { clearTimeout(timer); resolve(stream); });
            stream.once("close", () => clearTimeout(timer));
          });
          socket = candidate;
          socket.on("error", () => {});
          socket.once("close", () => {
            for (const item of pending.values()) item.reject(new Error("共有再生ワーカーとの接続が終了しました。自動再送はしません"));
            pending.clear();
          });
          readMessages(socket, (message) => {
            if (message.type === "finished") {
              if (!message.ok) log(`読み上げ ${message.jobId} が失敗しました: ${message.error}`);
              return;
            }
            const item = pending.get(message.id);
            if (!item) return;
            pending.delete(message.id);
            if (message.ok) item.resolve(message.result);
            else item.reject(new Error(message.error));
          });
          await request("hello", { token: prepared.token, version: 1 }, false);
          if (closed) {
            socket.destroy();
            throw new Error("このMCP接続は終了しています");
          }
          return;
        } catch (error) {
          socket?.destroy();
          if (error.code !== "ECONNREFUSED" || !autostart) throw error;
          if (!launched) {
            const worker = spawn(process.execPath, [fileURLToPath(new URL("./worker.js", import.meta.url))], {
              detached: true,
              stdio: "ignore",
              env: { ...process.env, MCP_SPEAK_QUEUE_DIR: config.directory, MCP_SPEAK_QUEUE_PORT: String(config.port) },
            });
            worker.on("error", () => {});
            worker.unref();
            launched = true;
          }
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      }
      throw new Error("共有ワーカーを起動できませんでした");
    })().finally(() => { connecting = undefined; });
    return connecting;
  }
  async function request(type, args, ensure = true, signal) {
    if (signal?.aborted) throw new Error("依頼はキャンセルされました");
    if (ensure) await connect();
    if (signal?.aborted) throw new Error("依頼はキャンセルされました");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket?.destroy();
        fail(new Error("キュー応答がタイムアウトしました。自動再送はしません"));
      }, 5000);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        pending.delete(id);
      };
      const fail = (error) => { cleanup(); reject(error); };
      const abort = () => {
        if (type === "enqueue") send(socket, { type: "cancel", id: randomUUID(), jobId: id });
        fail(new Error("依頼はキャンセルされました"));
      };
      pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: fail,
      });
      signal?.addEventListener("abort", abort, { once: true });
      send(socket, { type, id, ...args });
    });
  }
  return {
    async speak(args, { signal } = {}) {
      const input = validateSpeak(args);
      if (Buffer.byteLength(input.text) > MAX_TEXT_BYTES) throw new Error("textはUTF-8で64KiB以内にしてください");
      const queued = await request("enqueue", { args: input }, true, signal);
      return { ...input, ...queued };
    },
    listVoices: () => local.listVoices(),
    status: () => request("status", {}),
    stopQueue: () => request("stop", {}),
    mute: (mode) => request("mute", { mode }),
    unmute: () => request("unmute", {}),
    shutdownWorker: () => request("shutdown", {}),
    stop() {
      closed = true;
      socket?.destroy();
      local.stop();
    },
  };
}
