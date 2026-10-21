import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import fs from "node:fs/promises";
import { fork } from "node:child_process";
import { once } from "node:events";
import { monitorExit, waitForGuard } from "../src/playback-monitor.js";

function clock() {
  let now = 0;
  const tasks = new Set();
  return {
    later(fn, ms) { const timer = { fn, at: now + ms }; tasks.add(timer); return timer; },
    clear(timer) { tasks.delete(timer); },
    jump(ms) { now += ms; },
    run() { for (const timer of [...tasks]) if (timer.at <= now && tasks.delete(timer)) timer.fn(); },
    get size() { return tasks.size; },
  };
}
function child() {
  return Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
}
function pollOptions(probe = () => {}) {
  let poll;
  let cleared = false;
  return {
    options: { probe, every(fn) { poll = fn; return {}; }, clear() { cleared = true; } },
    poll() { poll(); },
    get cleared() { return cleared; },
  };
}
function setup(playbackMs = 120000) {
  const guard = child();
  const timers = clock();
  const polling = pollOptions();
  let cancels = 0;
  const messages = [];
  const promise = waitForGuard(guard, {
    playbackMs, cancel() { cancels++; }, onMessage(message) { messages.push(message); }, start() {},
  }, { later: timers.later, clear: timers.clear, monitor: (proc, done) => monitorExit(proc, done, polling.options) });
  return { guard, timers, polling, promise, messages, get cancels() { return cancels; } };
}

for (const event of ["exit", "close"]) {
  test(`${event} completes once even when competing exit/close/poll arrive`, () => {
    const proc = child();
    const poll = pollOptions();
    const results = [];
    monitorExit(proc, (...args) => results.push(args), poll.options);
    proc.emit(event, 0, null);
    proc.emit("exit", 1, null);
    proc.emit("close", 1, null);
    proc.exitCode = 0;
    poll.poll();
    assert.deepEqual(results, [[0, null]]);
    assert.equal(poll.cleared, true);
  });
}
for (const [property, value] of [["exitCode", 0], ["signalCode", "SIGTERM"]]) {
  test(`missing events recover using ${property}`, () => {
    const proc = child();
    const poll = pollOptions();
    const results = [];
    monitorExit(proc, (...args) => results.push(args), poll.options);
    proc[property] = value;
    poll.poll();
    assert.deepEqual(results, [[proc.exitCode, proc.signalCode]]);
  });
}
for (const code of ["ESRCH", "EPERM", "EIO"]) {
  test(`process probe ${code} ${code === "ESRCH" ? "confirms death without claiming success" : "keeps the guard"}`, () => {
    const proc = child();
    const poll = pollOptions(() => { throw Object.assign(new Error(code), { code }); });
    const results = [];
    const dispose = monitorExit(proc, (...args) => results.push(args), poll.options);
    poll.poll();
    assert.deepEqual(results, code === "ESRCH" ? [[null, null]] : []);
    dispose();
  });
}

test("normal and long playback retain the configured limit without cancellation", async () => {
  const c = setup(600000);
  c.timers.jump(599999); c.timers.run(); c.polling.poll();
  assert.equal(c.cancels, 0);
  c.guard.emit("message", { type: "result", ok: true });
  c.guard.emit("exit", 0, null);
  await c.promise;
  assert.deepEqual(c.messages, [{ type: "result", ok: true }]);
  assert.equal(c.timers.size, 0);
});

test("wake with worker watchdog first allows guard cleanup before deciding fault", async () => {
  const c = setup();
  // No callbacks execute while asleep. All original deadlines are overdue.
  c.timers.jump(3600000); c.timers.run();
  assert.equal(c.cancels, 1);
  c.timers.run(); // fresh grace must not already be overdue
  c.guard.emit("message", { type: "result", ok: false, error: "timeout" });
  c.guard.emit("exit", 0, null);
  await c.promise;
  assert.equal(c.timers.size, 0);
});

test("wake with guard exit first cancels the stale watchdog", async () => {
  const c = setup();
  c.timers.jump(3600000);
  c.guard.emit("exit", 0, null);
  c.timers.run();
  await c.promise;
  assert.equal(c.cancels, 0);
});

test("missing guard exit event recovers by polling and cancels stale timers", async () => {
  const c = setup();
  c.timers.jump(3600000); c.timers.run();
  c.guard.exitCode = 0;
  c.polling.poll();
  await c.promise;
  c.guard.emit("exit", 0, null);
  c.timers.jump(5000); c.timers.run();
  assert.equal(c.timers.size, 0);
});

test("a surviving unresponsive guard still faults after a fresh bounded grace", async () => {
  const c = setup();
  const rejected = assert.rejects(c.promise, /再生ガードの終了を確認できません/);
  c.timers.jump(125000); c.timers.run(); c.polling.poll();
  c.timers.jump(4999); c.timers.run();
  assert.equal(c.timers.size, 1);
  c.timers.jump(1); c.timers.run();
  await rejected;
  c.guard.emit("exit", 0, null);
  assert.equal(c.polling.cleared, true);
});

test("IPC send failure rejects and removes watchdog and process polling", async () => {
  const timers = clock();
  const poll = pollOptions();
  await assert.rejects(waitForGuard(child(), {
    playbackMs: 120000, cancel() {}, onMessage() {},
    start(done) { done(new Error("send failed")); },
  }, { later: timers.later, clear: timers.clear, monitor: (proc, done) => monitorExit(proc, done, poll.options) }), /send failed/);
  assert.equal(timers.size, 0);
  assert.equal(poll.cleared, true);
});


test("guard releases its lease after player exit even when inherited stderr never closes", async (t) => {
  const directory = await fs.mkdtemp("/tmp/mcp-speak-monitor-test-");
  const pidFile = `${directory}/holder-pid`;
  const script = `${directory}/player.cjs`;
  await fs.writeFile(script, `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    process.stdin.resume();
    process.stdin.on("end", () => {
      const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: ["ignore", "ignore", 2] });
      holder.once("spawn", () => { writeFileSync(${JSON.stringify(pidFile)}, String(holder.pid)); process.exit(0); });
    });
  `);
  const guard = fork(new URL("../src/playback-guard.js", import.meta.url), [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(async () => {
    if (guard.exitCode === null && guard.signalCode === null) {
      const exited = once(guard, "exit"); guard.kill("SIGKILL"); await exited;
    }
    const pid = await fs.readFile(pidFile, "utf8").catch(() => null);
    if (pid) { try { process.kill(Number(pid), "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const results = [];
  guard.on("message", (message) => { if (message.type === "result") results.push(message); });
  const exited = once(guard, "exit");
  guard.send({ directory, args: { text: "test" }, player: [process.execPath, script], playbackMs: 120000 });
  let timer;
  try {
    await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("guard waited for inherited stderr")), 3000); })]);
  } finally { clearTimeout(timer); }
  assert.deepEqual(results, [{ type: "result", ok: true }]);
  await assert.rejects(fs.lstat(`${directory}/playback.json`), { code: "ENOENT" });
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  assert.doesNotThrow(() => process.kill(pid, 0));
});
