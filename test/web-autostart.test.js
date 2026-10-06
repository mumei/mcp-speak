import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { attachWeb } from "../src/web-runtime.js";

async function waitFor(check) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const result = await check(); if (result) return result; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("Web lifecycle condition timed out");
}
async function freePort() {
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise((r) => server.close(r)); return port;
}
async function context(t) {
  const root = await fs.mkdtemp("/tmp/mcp-speak-auto-web-test-");
  const port = await freePort(); const queuePort = await freePort();
  const env = { ...process.env, MCP_SPEAK_WEB_AUTOSTART: "1", MCP_SPEAK_QUEUE_DIR: `${root}/queue`,
    MCP_SPEAK_QUEUE_PORT: String(queuePort), MCP_SPEAK_WEB_PORT: String(port), MCP_SPEAK_WEB_IDLE_MS: "800",
    QUEUE_TEST_EVENTS: `${root}/events`, QUEUE_TEST_IDLE: "20000" };
  const clients = []; const children = [];
  const worker = fork(fileURLToPath(new URL("./fixtures/worker.js", import.meta.url)), [], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  await once(worker, "message");
  const recordPath = `${env.MCP_SPEAK_QUEUE_DIR}/web-${port}.json`;
  const read = () => fs.readFile(recordPath, "utf8").then(JSON.parse).catch((e) => { if (e.code === "ENOENT") return null; throw e; });
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
    const info = await read(); if (info) { try { process.kill(info.pid, "SIGTERM"); } catch (e) { if (e.code !== "ESRCH") throw e; } await waitFor(async () => !(await read())); }
    if (worker.exitCode === null && worker.signalCode === null) { const exited = once(worker, "exit"); worker.send({ close: true }); await exited; }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { env, port, worker, recordPath, read,
    async mcp(extra = {}) {
      const client = new Client({ name: "auto-web-integration", version: "1.0.0" }, { capabilities: {} }); clients.push(client);
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../index.js", import.meta.url))], env: { ...env, ...extra }, stderr: "pipe" }));
      return client;
    },
    async manual() {
      const child = spawn(process.execPath, [fileURLToPath(new URL("../src/web-cli.js", import.meta.url))], { env, stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
      let output = ""; child.stdout.on("data", (chunk) => { output += chunk; });
      await waitFor(() => output.includes("#token="));
      return { child, output };
    },
    async api(info, route = "state", body) {
      const response = await fetch(`http://127.0.0.1:${port}/api/${route}`, { method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${info.token}`, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      assert.equal(response.status, 200); return response.json();
    },
  };
}

test("MCP startup shares one authenticated Web server with manual CLI and releases it after the last owner", async (t) => {
  const c = await context(t);
  const [one, two] = await Promise.all([c.mcp(), c.mcp()]);
  const info = await waitFor(c.read);
  assert.equal((await fs.stat(c.recordPath)).mode & 0o077, 0);
  assert.equal((await c.api(info, "identity")).pid, info.pid);
  assert.ok((await one.listTools()).tools.some((tool) => tool.name === "speak"));
  await c.api(info, "mute", { mode: "hold" });
  await one.callTool({ name: "speak", arguments: { text: "real MCP request held for the Web test" } });
  const state = await c.api(info);
  assert.equal(state.state.workerPid, c.worker.pid); assert.equal(state.state.muted, true);
  assert.equal(state.history.entries[0].status, "accepted");
  const manual = await c.manual();
  assert.equal(manual.output.includes(info.token), true);
  assert.equal((await c.read()).pid, info.pid);
  await one.close(); await two.close();
  assert.equal((await c.api(info, "identity")).pid, info.pid);
  const exited = once(manual.child, "exit"); manual.child.kill("SIGTERM"); await exited;
  await waitFor(async () => !(await c.read()));
  await assert.rejects(fetch(`http://127.0.0.1:${c.port}/`));
});

test("running MCP recreates a killed Web sidecar, rotates authentication and preserves worker mute/history", async (t) => {
  const c = await context(t); const client = await c.mcp();
  const before = await waitFor(c.read);
  await c.api(before, "mute", { mode: "discard" });
  await client.callTool({ name: "speak", arguments: { text: "discarded through MCP" } });
  process.kill(before.pid, "SIGKILL");
  const after = await waitFor(async () => { const info = await c.read(); return info && info.pid !== before.pid && info; });
  assert.notEqual(after.token, before.token);
  const state = await c.api(after);
  assert.equal(state.state.workerPid, c.worker.pid); assert.equal(state.state.muteMode, "discard");
  assert.equal(state.history.entries[0].status, "discarded");
  const old = await fetch(`http://127.0.0.1:${c.port}/api/state`, { headers: { Authorization: `Bearer ${before.token}` } });
  assert.equal(old.status, 401);
});

test("MCP Web autostart can be disabled without breaking the stdio protocol", async (t) => {
  const c = await context(t); const client = await c.mcp({ MCP_SPEAK_WEB_AUTOSTART: "0" });
  assert.ok((await client.listTools()).tools.length > 0);
  assert.equal(await c.read(), null);
});

test("private Web startup information rejects shared permissions and symlinks", async (t) => {
  const c = await context(t);
  const config = { directory: c.env.MCP_SPEAK_QUEUE_DIR, port: Number(c.env.MCP_SPEAK_QUEUE_PORT) };
  await fs.mkdir(config.directory, { mode: 0o700, recursive: true });
  await fs.writeFile(c.recordPath, "{}", { mode: 0o644 });
  await assert.rejects(attachWeb({ config, port: c.port }), /所有者・権限/);
  await fs.unlink(c.recordPath);
  const target = `${config.directory}/private-record`;
  await fs.writeFile(target, "{}", { mode: 0o600 }); await fs.symlink(target, c.recordPath);
  await assert.rejects(attachWeb({ config, port: c.port }), { code: "ELOOP" });
  await fs.unlink(c.recordPath);
});

test("an occupied Web port does not prevent MCP initialization or tool calls", async (t) => {
  const c = await context(t); const unrelated = net.createServer();
  unrelated.listen(c.port, "127.0.0.1"); await once(unrelated, "listening");
  t.after(() => new Promise((resolve) => unrelated.close(resolve)));
  const client = await c.mcp();
  assert.ok((await client.listTools()).tools.length > 0);
  const result = await client.callTool({ name: "queue_status", arguments: {} });
  assert.notEqual(result.isError, true);
  assert.equal(await c.read(), null);
});
