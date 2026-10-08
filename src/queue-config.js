import fs from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";

export const MAX_JOBS = 100;
export const MAX_TEXT_BYTES = 65536;
export const MAX_MESSAGE_BYTES = 524288;
export function queueConfig() {
  const uid = process.getuid();
  return {
    directory: process.env.MCP_SPEAK_QUEUE_DIR || `/tmp/mcp-speak-${uid}-v1`,
    settingsDirectory: process.env.MCP_SPEAK_SETTINGS_DIR || process.env.MCP_SPEAK_QUEUE_DIR || path.join(homedir(), "Library", "Application Support", "mcp-speak"),
    port: Number(process.env.MCP_SPEAK_QUEUE_PORT || (43000 + uid % 1000)),
  };
}

export async function prepareConfig(config = queueConfig()) {
  const { directory, port } = config;
  if (!path.isAbsolute(directory) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("キューのディレクトリ・ポート設定が不正です");
  }
  await fs.mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("キューのディレクトリは自分が所有する権限700の実ディレクトリにしてください");
  }
  const tokenPath = path.join(directory, "token");
  try {
    const file = await fs.open(tokenPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(randomBytes(32).toString("hex")); } finally { await file.close(); }
  } catch (error) { if (error.code !== "EEXIST") throw error; }
  // Another process may be finishing the initial atomic creation.
  for (let attempt = 0; attempt < 50; attempt++) {
    const file = await fs.open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const tokenStat = await file.stat();
      if (!tokenStat.isFile() || tokenStat.uid !== process.getuid() || (tokenStat.mode & 0o077) !== 0 || tokenStat.size > 64) {
        throw new Error("キューの認証ファイルの所有者・権限が不正です");
      }
      const token = await file.readFile("utf8");
      if (/^[a-f0-9]{64}$/.test(token)) return { ...config, token };
    } finally { await file.close(); }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("キューの認証ファイルを読み取れません");
}

export function send(socket, message) {
  if (socket.writableLength > MAX_MESSAGE_BYTES) return socket.destroy();
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

export function readMessages(socket, onMessage) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (data) => {
    buffer += data;
    if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) return socket.destroy();
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try { onMessage(JSON.parse(line)); } catch { socket.destroy(); }
    }
  });
}
