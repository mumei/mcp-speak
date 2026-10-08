import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { prepareConfig, queueConfig } from "./queue-config.js";
import { startWeb } from "./web-server.js";

export function webPort() {
  const port = Number(process.env.MCP_SPEAK_WEB_PORT || 44501);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Webポートが不正です");
  return port;
}
const registryPath = (config, port) => path.join(config.directory, `web-${port}.json`);
async function readRegistry(config, port) {
  let file;
  try {
    file = await fs.open(registryPath(config, port), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 8192) throw new Error("Web起動情報の所有者・権限が不正です");
    const info = JSON.parse(await file.readFile("utf8"));
    if (info.port !== port || info.directory !== config.directory || info.queuePort !== config.port || info.uid !== process.getuid() || !/^[a-f0-9-]{36}$/.test(info.instanceId) || !Number.isInteger(info.pid) || info.pid < 1) throw new Error("Web起動情報が接続先と一致しません");
    return info;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  finally { await file?.close(); }
}
function request(info, route, lease = false) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port: info.port, path: route,
      headers: { Origin: `http://127.0.0.1:${info.port}` }, agent: false }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error("Web受付を確認できません")); return; }
      if (lease) {
        if (res.headers["x-mcp-speak-instance"] !== info.instanceId) { res.destroy(); reject(new Error("Web受付が切り替わりました")); return; }
        req.setTimeout(0);
        const closed = new Promise((done) => res.once("close", done));
        res.on("error", () => {}); res.resume();
        resolve({ ...info, url: `http://127.0.0.1:${info.port}/`, closed, close: () => req.destroy() });
        return;
      }
      let body = "";
      res.on("data", (chunk) => { body += chunk; if (body.length > 8192) req.destroy(new Error("Web返信が大きすぎます")); });
      res.once("error", reject);
      res.once("end", () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    req.setTimeout(1500, () => req.destroy(new Error("Web受付が応答しません")));
    req.once("error", reject);
  });
}
export async function attachWeb({ config = queueConfig(), port = webPort(), signal } = {}) {
  await prepareConfig(config);
  let launched = false; let launchError;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (signal?.aborted) throw new Error("Web接続は終了しました");
    const info = await readRegistry(config, port);
    if (info) {
      try {
        const identity = await request(info, "/api/identity");
        if (signal?.aborted) throw new Error("Web接続は終了しました");
        if (identity.directory !== config.directory || identity.queuePort !== config.port || identity.uid !== process.getuid() || identity.pid !== info.pid || identity.instanceId !== info.instanceId) throw new Error("Web受付の接続先が違います");
        const lease = await request(info, "/api/lease", true);
        if (signal?.aborted) { lease.close(); throw new Error("Web接続は終了しました"); }
        return lease;
      } catch { /* A dead sidecar may leave its last private startup record. */ }
    }
    if (signal?.aborted) throw new Error("Web接続は終了しました");
    if (!launched) {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./web-cli.js", import.meta.url)), "--daemon"], {
        detached: true, stdio: "ignore", env: { ...process.env, MCP_SPEAK_QUEUE_DIR: config.directory,
          MCP_SPEAK_QUEUE_PORT: String(config.port), MCP_SPEAK_SETTINGS_DIR: config.settingsDirectory || config.directory, MCP_SPEAK_WEB_PORT: String(port) },
      });
      child.once("error", (error) => { launchError = error; }); child.unref(); launched = true;
    }
    if (launchError) throw launchError;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("共通Web受付を起動できません。Webポートとキュー設定を確認してください");
}
export function holdWeb(options = {}) {
  const controller = new AbortController();
  let stopped = false; let lease; let retry;
  let first = true; let resolveReady; let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  async function connect() {
    try {
      const candidate = await attachWeb({ ...options, signal: controller.signal });
      if (stopped) { candidate.close(); return; }
      lease = candidate;
      options.onReady?.(candidate);
      if (first) { first = false; resolveReady(candidate); }
      await candidate.closed;
    } catch (error) {
      if (stopped) return;
      if (first) { first = false; rejectReady(error); }
      options.log?.(`Web受付: ${error.message}`);
    }
    if (!stopped) { retry = setTimeout(connect, 1000); retry.unref(); }
  }
  void connect();
  return { ready, stop() { stopped = true; controller.abort(); clearTimeout(retry); lease?.close(); } };
}
export async function runWebDaemon({ config = queueConfig(), port = webPort(), idleMs = Number(process.env.MCP_SPEAK_WEB_IDLE_MS || 60000) } = {}) {
  if (!Number.isInteger(idleMs) || idleMs < 100 || idleMs > 3600000) throw new Error("Web終了待ち時間が不正です");
  await prepareConfig(config);
  let leases = 0; let idle; let closing = false; let web;
  const schedule = () => { clearTimeout(idle); if (!leases && !closing) idle = setTimeout(() => void close(), idleMs); };
  const identity = { directory: config.directory, queuePort: config.port, uid: process.getuid(), pid: process.pid, instanceId: randomUUID() };
  web = await startWeb({ port, identity,
    onLease: (res) => { leases++; clearTimeout(idle); res.once("close", () => { leases--; schedule(); }); },
  });
  const info = { ...identity, port };
  const destination = registryPath(config, port);
  const temp = `${destination}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(info), { mode: 0o600, flag: "wx" }); await fs.rename(temp, destination); }
  catch (error) { await web.close(); await fs.unlink(temp).catch(() => {}); throw error; }
  async function close() {
    if (closing) return;
    closing = true; clearTimeout(idle);
    const current = await readRegistry(config, port).catch(() => null);
    if (current?.instanceId === identity.instanceId) await fs.unlink(destination).catch(() => {});
    await web.close();
  }
  schedule();
  return { ...web, close };
}
