import { startWorker } from "../../src/worker.js";
import { queueConfig } from "../../src/queue-config.js";
import { fileURLToPath } from "node:url";
const worker = await startWorker({
  config: queueConfig(),
  player: [process.execPath, fileURLToPath(new URL("./player.js", import.meta.url))],
  idleMs: 500,
  playbackMs: Number(process.env.QUEUE_TEST_TIMEOUT || 120000),
});
process.send({ ready: true });
worker.server.once("close", () => { if (process.connected) process.disconnect(); });
const close = () => worker.close().then(() => { if (process.connected) process.disconnect(); });
process.on("message", close);
process.on("SIGTERM", close);
