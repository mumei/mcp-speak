import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { prepareConfig, queueConfig, readMessages, send, MAX_TEXT_BYTES } from "./queue-config.js";
import { createSpeech, validateSpeak } from "./speech.js";

export function createQueueSpeech({ config = queueConfig(), autostart = true, log = console.error, requestTimeoutMs = 5000 } = {}) {
  let socket;
  let connecting;
  let closed = false;
  const pending = new Map();
  const local = createSpeech();
  async function connect() {
    if (closed) throw new Error("このMCP接続は終了しています");
    if (connecting) return connecting;
    connecting = (async () => {
      if (socket && !socket.destroyed) {
        const current = socket;
        try {
          // Probe without enqueueing: a lost reply must never replay speech.
          await request("status", {}, false, undefined, current);
          if (closed) throw new Error("このMCP接続は終了しています");
          return;
        } catch (error) {
          current.destroy();
          if (socket === current) socket = undefined;
          if (closed) throw error;
        }
      }
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
          candidate.on("error", () => {});
          candidate.once("close", () => {
            if (socket === candidate) socket = undefined;
            for (const item of pending.values()) {
              if (item.socket === candidate) item.reject(new Error("共有再生ワーカーとの接続が終了しました。自動再送はしません"));
            }
          });
          readMessages(candidate, (message) => {
            if (message.type === "finished") {
              if (!message.ok) log(`読み上げ ${message.jobId} が失敗しました: ${message.error}`);
              return;
            }
            const item = pending.get(message.id);
            if (!item || item.socket !== candidate) return;
            pending.delete(message.id);
            if (message.ok) item.resolve(message.result);
            else item.reject(new Error(message.error));
          });
          await request("hello", { token: prepared.token, version: 1 }, false, undefined, candidate);
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
  async function request(type, args, ensure = true, signal, connection) {
    if (signal?.aborted) throw new Error("依頼はキャンセルされました");
    if (ensure) await connect();
    if (signal?.aborted) throw new Error("依頼はキャンセルされました");
    const stream = connection || socket;
    if (!stream || stream.destroyed || closed) throw new Error("共有再生ワーカーとの接続が終了しました。自動再送はしません");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stream.destroy();
        fail(new Error("キュー応答がタイムアウトしました。自動再送はしません"));
      }, requestTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        pending.delete(id);
      };
      const fail = (error) => { cleanup(); reject(error); };
      const abort = () => {
        if (type === "enqueue") send(stream, { type: "cancel", id: randomUUID(), jobId: id });
        fail(new Error("依頼はキャンセルされました"));
      };
      pending.set(id, {
        socket: stream,
        resolve: (value) => { cleanup(); resolve(value); },
        reject: fail,
      });
      signal?.addEventListener("abort", abort, { once: true });
      send(stream, { type, id, ...args });
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
    history: () => request("history", {}),
    clearHistory: () => request("clear_history", {}),
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
