import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { createSpeech, validateSpeak } from "../src/speech.js";

function fakeProcess({ error, writeError, exitBeforeSpawn = false } = {}) {
  const child = new EventEmitter();
  child.input = "";
  child.stdin = new Writable({
    write(chunk, encoding, done) {
      child.input += chunk.toString();
      done(writeError);
    },
  });
  child.stderr = new PassThrough();
  child.killCount = 0;
  child.kill = () => { child.killCount++; };
  queueMicrotask(() => {
    if (exitBeforeSpawn) child.emit("close", 0, null);
    else child.emit(error ? "error" : "spawn", error);
  });
  return child;
}

test("rate has an explicit default and accepts both boundaries", () => {
  assert.equal(validateSpeak({ text: "hello" }).rate, 175);
  for (const rate of [1, 500]) assert.equal(validateSpeak({ text: "hello", rate }).rate, rate);
});

const invalidInputs = [
  undefined, null, [], {}, { text: "" }, { text: " \n " }, { text: 123 },
  { text: "hello", voice: "" }, { text: "hello", voice: 1 },
  { text: "hello", rate: 0 }, { text: "hello", rate: 501 },
  { text: "hello", rate: -1 }, { text: "hello", rate: 1.5 },
  { text: "hello", rate: "175" }, { text: "hello", rate: {} },
  { text: "hello", rate: NaN }, { text: "hello", rate: Infinity },
  { text: "hello", rate: null }, { text: "hello", unknown: true },
];
for (const [index, input] of invalidInputs.entries()) {
  test(`invalid input ${index + 1} is rejected before spawning`, async () => {
    const speech = createSpeech({ spawnProcess: () => { assert.fail("must not spawn"); } });
    await assert.rejects(speech.speak(input));
  });
}

test("option-like text and shell characters go to stdin as literal text", async () => {
  let child;
  const speech = createSpeech({ spawnProcess(command, args, options) {
    assert.equal(command, "/usr/bin/say");
    assert.deepEqual(args, ["-r", "175", "-v", "Kyoko"]);
    assert.deepEqual(options.stdio, ["pipe", "ignore", "pipe"]);
    assert.equal(options.shell, false);
    child = fakeProcess();
    return child;
  } });
  const text = "-f/private/test $(touch example) `echo test`\n日本語";
  const result = await speech.speak({ text, voice: "Kyoko" });
  assert.equal(child.input, text);
  assert.equal(result.rate, 175);
  child.emit("close", 0, null);
});

test("asynchronous spawn failure rejects", async () => {
  const speech = createSpeech({ spawnProcess: () => fakeProcess({ error: new Error("ENOENT") }) });
  await assert.rejects(speech.speak({ text: "hello" }), /ENOENT/);
});

test("stdin failure rejects without an unhandled stream error", async () => {
  const speech = createSpeech({ spawnProcess: () => fakeProcess({ writeError: new Error("EPIPE") }) });
  await assert.rejects(speech.speak({ text: "hello" }), /EPIPE/);
});

test("synchronous spawn failure rejects", async () => {
  const speech = createSpeech({ spawnProcess: () => { throw new Error("spawn failure"); } });
  await assert.rejects(speech.speak({ text: "hello" }), /spawn failure/);
});

test("exit before text submission is an error even with exit code zero", async () => {
  const speech = createSpeech({ spawnProcess: () => fakeProcess({ exitBeforeSpawn: true }) });
  await assert.rejects(speech.speak({ text: "hello" }), /送信前/);
});

test("late failure is logged and successful exit removes the child", async () => {
  const logs = [];
  const children = [];
  const speech = createSpeech({
    spawnProcess: () => { const child = fakeProcess(); children.push(child); return child; },
    log: (message) => logs.push(message),
  });
  await speech.speak({ text: "one" });
  children[0].stderr.write("voice failed");
  children[0].emit("close", 1, null);
  assert.match(logs[0], /voice failed/);
  await speech.speak({ text: "two" });
  children[1].emit("close", 0, null);
  speech.stop();
  assert.equal(children[0].killCount, 0);
  assert.equal(children[1].killCount, 0);
});

test("shutdown terminates active speech processes", async () => {
  const child = fakeProcess();
  const speech = createSpeech({ spawnProcess: () => child });
  await speech.speak({ text: "hello" });
  speech.stop();
  assert.equal(child.killCount, 1);
});

test("list voices uses execFile with bounded output and a timeout", async () => {
  const speech = createSpeech({ executeFile: async (command, args, options) => {
    assert.equal(command, "/usr/bin/say");
    assert.deepEqual(args, ["-v", "?"]);
    assert.equal(options.timeout, 10000);
    assert.equal(options.maxBuffer, 1024 * 1024);
    return { stdout: "Kyoko ja_JP" };
  } });
  assert.equal(await speech.listVoices(), "Kyoko ja_JP");
});
