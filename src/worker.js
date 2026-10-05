import net from "node:net";
import fs from "node:fs/promises";
import { constants, openSync, readFileSync, closeSync, writeFileSync, renameSync, fstatSync } from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { prepareConfig, queueConfig, readMessages, send, MAX_JOBS, MAX_TEXT_BYTES } from "./queue-config.js";
import { validateSpeak, validateObject } from "./speech.js";

export async function startWorker({ config = queueConfig(), player = ["/usr/bin/say"], idleMs = 60000, playbackMs = 120000, onEvent = () => {} } = {}) {
  const prepared = await prepareConfig(config);
  const lease = path.join(config.directory, "playback.json");
  const sockets = new Set();
  let queue = [];
  let active;
  let fault;
  let shutdown = false;
  let idleTimer;
  let draining = false;
  let muted = false;
  let muteMode = "hold";
  const statePath = path.join(config.directory, "mute-state.json");
  try {
    const fd = openSync(statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 1024) throw new Error("ミュート状態ファイルの権限・サイズが不正です");
      const state = JSON.parse(readFileSync(fd, "utf8"));
      if (typeof state.muted !== "boolean" || !["hold", "discard"].includes(state.mode)) throw new Error("ミュート状態ファイルが不正です");
      muted = state.muted;
      muteMode = state.mode;
    } finally { closeSync(fd); }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  function saveMute(state) {
    const temporary = `${statePath}.${randomUUID()}`;
    writeFileSync(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    renameSync(temporary, statePath);
  }
  const server = net.createServer((socket) => {
    if (sockets.size >= 64 || shutdown) return socket.destroy();
    sockets.add(socket);
    clearTimeout(idleTimer);
    let authenticated = false;
    const authTimer = setTimeout(() => socket.destroy(), 1000);
    socket.on("error", () => {});
    socket.once("close", () => {
      clearTimeout(authTimer);
      sockets.delete(socket);
      queue = queue.filter((job) => job.socket !== socket);
      if (active?.socket === socket) cancelActive();
      scheduleIdle();
    });
    readMessages(socket, (message) => {
      const reply = (result) => send(socket, { id: message.id, ok: true, result });
      try {
        if (!message || typeof message.id !== "string" || message.id.length > 80) throw new Error("不正なリクエストです");
        if (!authenticated) {
          if (message.type !== "hello" || message.version !== 1 || typeof message.token !== "string" ||
              !/^[a-f0-9]{64}$/.test(message.token) ||
              !timingSafeEqual(Buffer.from(message.token), Buffer.from(prepared.token))) {
            send(socket, { id: message.id, ok: false, error: "ワーカーの認証・バージョンが一致しません" });
            return socket.end();
          }
          authenticated = true;
          clearTimeout(authTimer);
          return reply({ workerPid: process.pid, version: 1 });
        }
        if (message.type === "status") return reply({ workerPid: process.pid, pending: queue.length, playing: Boolean(active), muted, muteMode, fault: fault || null, maxJobs: MAX_JOBS });
        if (message.type === "cancel") {
          queue = queue.filter((job) => !(job.id === message.jobId && job.socket === socket));
          if (active?.id === message.jobId && active.socket === socket) cancelActive();
          return reply({ cancelled: true });
        }
        if (message.type === "mute") {
          if (!["hold", "discard"].includes(message.mode)) throw new Error("modeはholdまたはdiscardを指定してください");
          saveMute({ muted: true, mode: message.mode });
          muted = true;
          muteMode = message.mode;
          const discarded = muteMode === "discard" ? clearQueue() : 0;
          cancelActive();
          return reply({ muted, muteMode, discarded, stopping: Boolean(active) });
        }
        if (message.type === "unmute") {
          saveMute({ muted: false, mode: muteMode });
          muted = false;
          reply({ muted, muteMode, pending: queue.length });
          void drain();
          return;
        }
        if (message.type === "stop") {
          const discarded = clearQueue();
          cancelActive();
          return reply({ discarded, stopping: Boolean(active) });
        }
        if (message.type === "shutdown") {
          reply({ shuttingDown: true });
          void close();
          return;
        }
        if (message.type !== "enqueue") throw new Error("未対応の操作です");
        if (fault || shutdown) throw new Error(fault || "ワーカーは停止中です");
        validateObject(message.args, ["text", "voice", "rate"]);
        const input = validateSpeak(message.args);
        if (Buffer.byteLength(input.text) > MAX_TEXT_BYTES || (input.voice?.length || 0) > 256) throw new Error("読み上げ入力が上限を超えています");
        if (muted && muteMode === "discard") return reply({ discarded: true, jobId: message.id, queuePosition: 0 });
        if (queue.length + (active ? 1 : 0) >= MAX_JOBS) throw new Error("共有キューが満杯です（上限100件）");
        if (queue.some((job) => job.id === message.id) || active?.id === message.id) throw new Error("重複した依頼IDです");
        queue.push({ id: message.id, input, socket });
        reply({ jobId: message.id, queuePosition: queue.length + (active ? 1 : 0) });
        void drain();
      } catch (error) { send(socket, { id: message?.id, ok: false, error: error.message }); }
    });
  });
  function finish(job, ok, error) { send(job.socket, { type: "finished", jobId: job.id, ok, error }); }
  function clearQueue() {
    const discarded = queue.length;
    for (const job of queue) finish(job, false, "待機中の読み上げは停止されました");
    queue = [];
    return discarded;
  }
  function cancelActive() {
    if (active?.guard.connected) active.guard.send({ type: "cancel" }, () => {});
  }
  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (!sockets.size && !active && !queue.length && !shutdown) idleTimer = setTimeout(() => void close(), idleMs);
  }
  async function drain() {
    if (draining || shutdown || fault || muted) return;
    draining = true;
    try {
      while (queue.length && !shutdown && !fault && !muted) {
        // A surviving guard keeps this lease until its owned say has really closed.
        for (let count = 0; ; count++) {
          const exists = await fs.lstat(lease).then(() => true, (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          });
          if (!exists) break;
          if (count >= 100) throw new Error("前の再生の停止を確認できません。再生記録を確認してからワーカーを再起動してください");
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        if (!queue.length || shutdown || muted) break;
        const job = queue.shift();
        if (job.socket.destroyed) continue;
        onEvent({ type: "start", jobId: job.id, time: Date.now() });
        const guard = fork(fileURLToPath(new URL("./playback-guard.js", import.meta.url)), [], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        active = { ...job, guard };
        let result;
        await new Promise((resolve, reject) => {
          const watchdog = setTimeout(() => {
            cancelActive();
            reject(new Error("再生ガードの終了を確認できません。安全のため共有キューを停止しました"));
          }, playbackMs + 5000);
          guard.on("message", (message) => { if (message.type === "result") result = message; });
          guard.on("error", (error) => { clearTimeout(watchdog); reject(error); });
          guard.once("exit", () => { clearTimeout(watchdog); resolve(); });
          guard.send({ directory: config.directory, args: job.input, player, playbackMs }, (error) => {
            if (error) { clearTimeout(watchdog); reject(error); }
          });
        });
        finish(job, Boolean(result?.ok), result?.error || (result ? undefined : "再生ガードが異常終了しました"));
        onEvent({ type: "end", jobId: job.id, time: Date.now(), ok: Boolean(result?.ok) });
        active = undefined;
      }
    } catch (error) {
      fault = error.message;
      if (active) finish(active, false, fault);
      clearQueue();
    } finally {
      draining = false;
      scheduleIdle();
    }
  }
  async function close() {
    if (shutdown) return;
    shutdown = true;
    clearTimeout(idleTimer);
    clearQueue();
    cancelActive();
    for (const socket of sockets) socket.end();
    server.close();
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: config.port, exclusive: true }, resolve);
  });
  scheduleIdle();
  return { close, server };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startWorker().then(({ close }) => {
    process.once("SIGTERM", () => void close());
    process.once("SIGINT", () => void close());
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
