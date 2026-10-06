import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { validateSpeak } from "./speech.js";

let child;
let cancelRequested = false;
let killTimer;
let timedOut = false;
function cancel() {
  cancelRequested = true;
  if (child) {
    child.kill("SIGTERM");
    killTimer ||= setTimeout(() => child?.kill("SIGKILL"), 1000);
  }
}
process.on("disconnect", cancel);
process.on("SIGTERM", cancel);
process.on("SIGINT", cancel);
process.on("message", (message) => { if (message?.type === "cancel") cancel(); });

process.once("message", async ({ directory, args, player, playbackMs }) => {
  if (!args) return;
  const lease = path.join(directory, "playback.json");
  const owner = randomUUID();
  let acquired = false;
  let deadline;
  try {
    const input = validateSpeak(args);
    const file = await fs.open(lease, "wx", 0o600);
    acquired = true;
    try { await file.writeFile(JSON.stringify({ owner, guardPid: process.pid })); } finally { await file.close(); }
    if (cancelRequested) throw new Error("再生はキャンセルされました");
    const options = ["-r", String(input.rate)];
    if (input.voice !== undefined) options.push("-v", input.voice);
    const [command, ...prefix] = player;
    let errorText = "";
    await new Promise((resolve, reject) => {
      child = spawn(command, [...prefix, ...options], { stdio: ["pipe", "ignore", "pipe"], shell: false });
      child.stderr.on("data", (data) => { errorText = (errorText + data).slice(-8192); });
      child.on("error", (error) => { errorText = error.message; });
      child.stdin.on("error", (error) => { errorText = error.message; cancel(); });
      child.once("spawn", () => {
        if (cancelRequested) cancel();
        else child.stdin.end(input.text, () => {
          if (process.connected && !cancelRequested) process.send({ type: "started" });
        });
      });
      child.once("close", (code) => {
        child = undefined;
        if (code === 0 && !cancelRequested) resolve();
        else reject(new Error(cancelRequested ? "再生はキャンセルされました" : `sayが失敗しました: ${errorText || code}`));
      });
      if (child.pid) {
        try { writeFileSync(lease, JSON.stringify({ owner, guardPid: process.pid, sayPid: child.pid }), { mode: 0o600 }); }
        catch (error) { errorText = error.message; cancel(); }
      }
      deadline = setTimeout(() => { timedOut = true; cancel(); }, playbackMs);
    });
    if (process.connected) process.send({ type: "result", ok: true });
  } catch (error) {
    if (process.connected) process.send({ type: "result", ok: false, cancelled: cancelRequested && !timedOut, error: timedOut ? "再生時間の上限を超えました" : error.message });
  } finally {
    clearTimeout(deadline);
    clearTimeout(killTimer);
    // Only this guard removes its own lease, and only after its say has closed.
    if (acquired && !child) {
      const record = JSON.parse(await fs.readFile(lease, "utf8"));
      if (record.owner === owner) await fs.unlink(lease);
    }
    if (process.connected) process.disconnect();
  }
});
