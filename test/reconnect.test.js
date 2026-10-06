import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import net from "node:net";
import { once } from "node:events";
import { createQueueSpeech } from "../src/queue-client.js";
import { readMessages, send } from "../src/queue-config.js";

async function endpoint(t, handle, helloDelay = 0) {
  const root = await fs.mkdtemp("/tmp/mcp-speak-reconnect-test-");
  const sockets = new Set();
  let connections = 0;
  let started;
  const helloStarted = new Promise((resolve) => { started = resolve; });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    const number = ++connections;
    let authenticated = false;
    readMessages(socket, (message) => {
      const reply = (result = {}) => send(socket, { id: message.id, ok: true, result });
      if (message.type === "hello") {
        started();
        return setTimeout(() => { authenticated = true; reply({ version: 1 }); }, helloDelay);
      }
      handle({ socket, message, reply, number, authenticated });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const queue = createQueueSpeech({
    config: { directory: `${root}/queue`, port: server.address().port },
    autostart: false,
    requestTimeoutMs: 300,
  });
  t.after(async () => {
    queue.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { queue, helloStarted, connections: () => connections };
}

test("silent stale connection is probed and replaced before enqueue", async (t) => {
  let stale = false;
  const accepted = [];
  const transmitted = [];
  const c = await endpoint(t, ({ message, reply, number }) => {
    if (message.type === "enqueue") transmitted.push(message.args.text);
    if (number === 1 && stale) return;
    if (message.type === "enqueue") accepted.push(message.args.text);
    reply({ jobId: message.id, pending: 0 });
  });
  await c.queue.status();
  stale = true;
  await c.queue.speak({ text: "once after wake" });
  assert.equal(c.connections(), 2);
  assert.deepEqual(transmitted, ["once after wake"]);
  assert.deepEqual(accepted, ["once after wake"]);
});

test("concurrent requests wait for authentication on a new connection", async (t) => {
  const observed = [];
  const c = await endpoint(t, ({ authenticated, reply }) => {
    observed.push(authenticated);
    reply();
  }, 25);
  const first = c.queue.status();
  await c.helloStarted;
  await Promise.all([first, c.queue.status()]);
  assert.equal(c.connections(), 1);
  assert.deepEqual(observed, [true, true]);
});

test("lost enqueue acknowledgement is never replayed on reconnect", async (t) => {
  const accepted = [];
  const c = await endpoint(t, ({ socket, message, reply }) => {
    if (message.type === "enqueue") {
      accepted.push(message.args.text);
      if (accepted.length === 1) return socket.destroy();
    }
    reply({ jobId: message.id });
  });
  await assert.rejects(c.queue.speak({ text: "uncertain" }), /自動再送はしません/);
  await c.queue.speak({ text: "new request" });
  assert.deepEqual(accepted, ["uncertain", "new request"]);
});
