import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import net from "node:net";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createQueueSpeech } from "../src/queue-client.js";
import { prepareConfig } from "../src/queue-config.js";
import { startWeb } from "../src/web-server.js";

async function waitFor(check, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("test condition timed out");
}

async function context(t, playbackMs = 120000, idleMs = 5000) {
  const root = await fs.mkdtemp("/tmp/mcp-speak-queue-test-");
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const config = { directory: `${root}/queue`, port };
  const eventsPath = `${root}/events`;
  const env = { ...process.env, MCP_SPEAK_WEB_AUTOSTART: "0", MCP_SPEAK_QUEUE_DIR: config.directory, MCP_SPEAK_QUEUE_PORT: String(port), QUEUE_TEST_EVENTS: eventsPath, QUEUE_TEST_TIMEOUT: String(playbackMs), QUEUE_TEST_IDLE: String(idleMs) };
  const workers = [];
  const clients = [];
  const queues = [];
  async function start() {
    const worker = fork(fileURLToPath(new URL("./fixtures/worker.js", import.meta.url)), [], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    workers.push(worker);
    let errors = "";
    worker.stderr.on("data", (data) => { errors += data; });
    await Promise.race([
      once(worker, "message"),
      once(worker, "exit").then(() => { throw new Error(errors || "worker exited during startup"); }),
    ]);
    return worker;
  }
  const worker = await start();
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const queue of queues) queue.stop();
    for (const child of workers) {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        if (child.connected) child.send({ close: true });
        else child.kill("SIGTERM");
        await exit;
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    config, worker, start, root,
    queue() { const speech = createQueueSpeech({ config, autostart: false, log: () => {} }); queues.push(speech); return speech; },
    async mcp() {
      const client = new Client({ name: "integration", version: "1.0.0" }, { capabilities: {} });
      clients.push(client);
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../index.js", import.meta.url))], env, stderr: "pipe" }));
      return client;
    },
    async events() {
      return fs.readFile(eventsPath, "utf8").then((value) => value.trim().split("\n").filter(Boolean).map(JSON.parse), (error) => { if (error.code === "ENOENT") return []; throw error; });
    },
  };
}

test("two real MCP processes share FIFO and never overlap playback", async (t) => {
  const c = await context(t);
  const [one, two] = await Promise.all([c.mcp(), c.mcp()]);
  for (const [client, text] of [[one, "one"], [two, "two"]]) {
    const result = await client.callTool({ name: "speak", arguments: { text } });
    assert.notEqual(result.isError, true);
  }
  const events = await waitFor(async () => { const events = await c.events(); return events.length === 4 && events; });
  assert.deepEqual(events.map(({ type, text }) => [type, text]), [["start", "one"], ["end", "one"], ["start", "two"], ["end", "two"]]);
  assert.ok(events[2].time >= events[1].time);
});

test("Web controls use the same worker, distinguish outcomes and clear only history", async (t) => {
  const c = await context(t);
  const one = c.queue();
  const web = await startWeb({ port: 0, speech: c.queue() });
  t.after(() => web.close());
  const headers = { Origin: web.origin, "Content-Type": "application/json" };
  const control = async (path, body = {}) => {
    const response = await fetch(`${web.origin}/api/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json();
  };
  await control("mute", { mode: "hold" });
  await one.speak({ text: "<img src=x onerror=alert(1)>" });
  const state = await (await fetch(`${web.origin}/api/state`, { headers })).json();
  assert.equal(state.state.workerPid, c.worker.pid);
  assert.equal(state.state.pending, 1);
  assert.equal(state.history.entries[0].status, "accepted");
  await control("mute", { mode: "discard" });
  await one.speak({ text: "dropped" });
  assert.deepEqual((await one.history()).entries.map((entry) => entry.status), ["discarded", "discarded"]);
  await control("unmute");
  await one.speak({ text: "hang" });
  await waitFor(async () => (await one.status()).current?.status === "playing");
  assert.equal((await one.status()).current.text, "hang");
  await control("mute", { mode: "hold" });
  await waitFor(async () => (await one.history()).entries[0].status === "cancelled");
  await control("unmute");
  await one.speak({ text: "fail" });
  await waitFor(async () => (await one.history()).entries[0].status === "failed");
  await one.speak({ text: "done" });
  await waitFor(async () => (await one.history()).entries[0].status === "completed");
  await control("mute", { mode: "hold" });
  await one.speak({ text: "still pending" });
  await control("clear-history");
  assert.equal((await one.history()).entries.length, 0);
  assert.equal((await one.status()).pending, 1);
  assert.equal((await one.status()).muted, true);
});

test("history is bounded, truncates long text and disappears on worker restart", async (t) => {
  const c = await context(t);
  const one = c.queue();
  await one.mute("discard");
  for (let i = 0; i < 102; i++) await one.speak({ text: `${i}:${"\u0001".repeat(1024)}` });
  const history = await one.history();
  assert.equal(history.entries.length, 100);
  assert.equal(Array.from(history.entries[0].text).length, 512);
  assert.equal(history.entries[0].truncated, true);
  assert.ok(history.entries.at(-1).text.startsWith("2:"));
  const exit = once(c.worker, "exit"); c.worker.send({ close: true }); await exit;
  await c.start();
  assert.equal((await one.history()).entries.length, 0);
  assert.equal((await one.status()).muteMode, "discard");
  assert.equal((await one.status()).muted, true);
});

test("failed playback advances the common queue", async (t) => {
  const c = await context(t);
  const one = c.queue();
  const two = c.queue();
  await one.speak({ text: "fail" });
  await two.speak({ text: "next" });
  const events = await waitFor(async () => { const events = await c.events(); return events.length === 4 && events; });
  assert.deepEqual(events.map(({ type, text }) => [type, text]), [["start", "fail"], ["end", "fail"], ["start", "next"], ["end", "next"]]);
});

test("client disconnect cancels only its own active job and pending work", async (t) => {
  const c = await context(t);
  const one = c.queue();
  const two = c.queue();
  await one.speak({ text: "hang" });
  await waitFor(async () => (await c.events()).length === 1);
  await one.speak({ text: "discarded" });
  await two.speak({ text: "survivor" });
  one.stop();
  const events = await waitFor(async () => { const events = await c.events(); return events.length === 4 && events; });
  assert.deepEqual(events.map(({ type, text }) => [type, text]), [["start", "hang"], ["end", "hang"], ["start", "survivor"], ["end", "survivor"]]);
});

test("SIGKILL of worker stops owned playback before replacement worker plays", async (t) => {
  const c = await context(t);
  const one = c.queue();
  await one.speak({ text: "hang" });
  await waitFor(async () => (await c.events()).length === 1);
  const exited = once(c.worker, "exit");
  c.worker.kill("SIGKILL");
  await exited;
  await c.start();
  const two = c.queue();
  await two.speak({ text: "replacement" });
  const events = await waitFor(async () => { const events = await c.events(); return events.length === 4 && events; });
  assert.deepEqual(events.map(({ type, text }) => [type, text]), [["start", "hang"], ["end", "hang"], ["start", "replacement"], ["end", "replacement"]]);
});

test("unauthenticated IPC, unsafe directories, and oversized input are rejected", async (t) => {
  const c = await context(t);
  const bad = net.createConnection({ host: "127.0.0.1", port: c.config.port });
  await once(bad, "connect");
  bad.write(JSON.stringify({ id: "bad", type: "hello", version: 1, token: "x".repeat(64) }) + "\n");
  const [data] = await once(bad, "data");
  assert.equal(JSON.parse(data.toString()).ok, false);
  bad.destroy();
  await assert.rejects(c.queue().speak({ text: "x".repeat(65537) }), /64KiB/);
  await fs.chmod(c.config.directory, 0o755);
  await assert.rejects(prepareConfig(c.config), /700/);
  await fs.chmod(c.config.directory, 0o700);
});

test("stop discards pending speech and allows later work", async (t) => {
  const c = await context(t);
  const one = c.queue();
  await one.speak({ text: "hang" });
  await waitFor(async () => (await c.events()).length === 1);
  await one.speak({ text: "discarded" });
  assert.equal((await one.stopQueue()).discarded, 1);
  await one.speak({ text: "after stop" });
  const events = await waitFor(async () => { const events = await c.events(); return events.length === 4 && events; });
  assert.equal(events[2].text, "after stop");
});

test("hold mute stops current speech without replay and releases FIFO on unmute", async (t) => {
  const c = await context(t);
  const one = c.queue();
  const two = c.queue();
  await one.speak({ text: "hang" });
  await waitFor(async () => (await c.events()).length === 1);
  await one.speak({ text: "held one" });
  await two.mute("hold");
  await two.speak({ text: "held two" });
  await waitFor(async () => (await c.events()).length === 2);
  const status = await one.status();
  assert.equal(status.muted, true);
  assert.equal(status.muteMode, "hold");
  assert.equal(status.pending, 2);
  await two.unmute();
  const events = await waitFor(async () => { const events = await c.events(); return events.length === 6 && events; });
  assert.deepEqual(events.filter((event) => event.type === "start").map((event) => event.text), ["hang", "held one", "held two"]);
});

test("discard and switching modes drop old speech rather than replay it", async (t) => {
  const c = await context(t);
  const one = c.queue();
  await one.mute("hold");
  await one.speak({ text: "old hold" });
  assert.equal((await one.mute("discard")).discarded, 1);
  assert.equal((await one.speak({ text: "discard new" })).discarded, true);
  assert.equal((await one.status()).pending, 0);
  await one.mute("hold");
  await one.speak({ text: "new hold" });
  await one.unmute();
  const events = await waitFor(async () => { const events = await c.events(); return events.length === 2 && events; });
  assert.equal(events[0].text, "new hold");
});

test("hold capacity rejects new job and preserves the 100 existing jobs", async (t) => {
  const c = await context(t);
  const one = c.queue();
  await one.mute("hold");
  for (let number = 0; number < 100; number++) await one.speak({ text: String(number) });
  await assert.rejects(one.speak({ text: "overflow" }), /満杯/);
  assert.equal((await one.status()).pending, 100);
  assert.equal((await one.stopQueue()).discarded, 100);
  assert.deepEqual(await c.events(), []);
});

test("MCP controls report mute mode and reject invalid mode", async (t) => {
  const c = await context(t);
  const client = await c.mcp();
  const muted = await client.callTool({ name: "mute_speech", arguments: { mode: "hold" } });
  assert.notEqual(muted.isError, true);
  const status = await client.callTool({ name: "queue_status", arguments: {} });
  assert.equal(JSON.parse(status.content[0].text).muteMode, "hold");
  const invalid = await client.callTool({ name: "mute_speech", arguments: { mode: "other" } });
  assert.equal(invalid.isError, true);
  const stopped = await client.callTool({ name: "stop_speech" });
  assert.notEqual(stopped.isError, true);
  const released = await client.callTool({ name: "unmute_speech" });
  assert.equal(JSON.parse(released.content[0].text).muted, false);
});

test("abandoned playback lease fails closed instead of overlapping unknown speech", async (t) => {
  const c = await context(t);
  await fs.writeFile(`${c.config.directory}/playback.json`, JSON.stringify({ owner: "abandoned" }));
  const one = c.queue();
  await one.speak({ text: "must not start" });
  const status = await waitFor(async () => { const state = await one.status(); return state.fault && state; });
  assert.match(status.fault, /停止を確認できません/);
  await assert.rejects(one.speak({ text: "also denied" }), /停止を確認できません/);
  assert.deepEqual(await c.events(), []);
});

test("worker stays exclusive, uses owned token permissions, and permits only its IPC", async (t) => {
  const c = await context(t);
  assert.equal((await fs.stat(c.config.directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(`${c.config.directory}/token`)).mode & 0o777, 0o600);
  const one = c.queue();
  const status = await one.status();
  assert.equal(status.workerPid, c.worker.pid);
  const { startWorker } = await import("../src/worker.js");
  await assert.rejects(startWorker({ config: c.config }), { code: "EADDRINUSE" });
});

test("mute state survives worker restart and does not silently unmute", async (t) => {
  const c = await context(t);
  const one = c.queue();
  await one.mute("discard");
  const exit = once(c.worker, "exit");
  c.worker.send({ close: true });
  await exit;
  await c.start();
  const two = c.queue();
  assert.equal((await two.status()).muted, true);
  assert.equal((await two.status()).muteMode, "discard");
  assert.equal((await two.speak({ text: "silenced" })).discarded, true);
  assert.deepEqual(await c.events(), []);
});

test("existing MCP clients reconnect after worker restart, preserve mute and share FIFO", async (t) => {
  const c = await context(t);
  const [one, two] = await Promise.all([c.mcp(), c.mcp()]);
  await one.callTool({ name: "mute_speech", arguments: { mode: "hold" } });
  await two.callTool({ name: "queue_status" });
  const exited = once(c.worker, "exit");
  c.worker.send({ close: true });
  await exited;
  await c.start();
  const state = await one.callTool({ name: "queue_status" });
  assert.notEqual(state.isError, true);
  assert.equal(JSON.parse(state.content[0].text).muteMode, "hold");
  assert.equal(JSON.parse(state.content[0].text).muted, true);
  for (const [client, text] of [[one, "resumed one"], [two, "resumed two"]]) {
    const result = await client.callTool({ name: "speak", arguments: { text } });
    assert.notEqual(result.isError, true);
  }
  assert.deepEqual(await c.events(), []);
  await two.callTool({ name: "unmute_speech" });
  const events = await waitFor(async () => { const events = await c.events(); return events.length === 4 && events; });
  assert.deepEqual(events.map(({ type, text }) => [type, text]), [["start", "resumed one"], ["end", "resumed one"], ["start", "resumed two"], ["end", "resumed two"]]);
  assert.ok(events[2].time >= events[1].time);
});

test("two MCP processes starting simultaneously elect only one common worker", async (t) => {
  const c = await context(t);
  const exit = once(c.worker, "exit");
  c.worker.send({ close: true });
  await exit;
  const [one, two] = await Promise.all([c.mcp(), c.mcp()]);
  const states = await Promise.all([one, two].map((client) => client.callTool({ name: "queue_status" })));
  for (const state of states) assert.notEqual(state.isError, true, state.content[0]?.text);
  assert.equal(JSON.parse(states[0].content[0].text).workerPid, JSON.parse(states[1].content[0].text).workerPid);
  await c.queue().shutdownWorker();
});

test("UTF-8 byte limit survives JSON escaping and cancelled requests never enqueue", async (t) => {
  const c = await context(t);
  const one = c.queue();
  await one.mute("hold");
  await one.speak({ text: "\u0001".repeat(65536) });
  assert.equal((await one.status()).pending, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(one.speak({ text: "cancelled" }, { signal: controller.signal }), /キャンセル/);
  assert.equal((await one.status()).pending, 1);
});

test("playback timeout kills an unresponsive owned player and advances FIFO", async (t) => {
  const c = await context(t, 250);
  const one = c.queue();
  await one.speak({ text: "ignore" });
  await waitFor(async () => (await c.events()).length === 1);
  await one.speak({ text: "after timeout" });
  const events = await waitFor(async () => { const events = await c.events(); return events.length === 3 && events; });
  assert.equal(events[1].text, "after timeout");
  assert.throws(() => process.kill(events[0].pid, 0), { code: "ESRCH" });
});

test("global stop leaves unrelated processes alive", async (t) => {
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(unrelated, "spawn");
  t.after(async () => {
    const exit = once(unrelated, "exit");
    unrelated.kill("SIGTERM");
    await exit;
  });
  const c = await context(t);
  const one = c.queue();
  await one.speak({ text: "hang" });
  await waitFor(async () => (await c.events()).length === 1);
  await one.stopQueue();
  await waitFor(async () => (await c.events()).length === 2);
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
});

test("idle worker exits after its last client disconnects", async (t) => {
  const c = await context(t, 120000, 500);
  const one = c.queue();
  await one.status();
  const exited = once(c.worker, "exit");
  const started = Date.now();
  one.stop();
  await exited;
  assert.ok(Date.now() - started >= 450);
});

test("SIGKILL of playback guard faults the worker rather than overlapping orphan playback", async (t) => {
  const c = await context(t);
  const one = c.queue();
  await one.speak({ text: "hang" });
  await waitFor(async () => (await c.events()).length === 1);
  const record = JSON.parse(await fs.readFile(`${c.config.directory}/playback.json`, "utf8"));
  const playerPid = (await c.events())[0].pid;
  assert.equal(record.sayPid, playerPid);
  t.after(() => { try { process.kill(playerPid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } });
  process.kill(record.guardPid, "SIGKILL");
  await one.speak({ text: "must not overlap" });
  await waitFor(async () => (await one.status()).fault);
  assert.equal((await c.events()).length, 1);
});
