import { createQueueSpeech } from "./queue-client.js";

const command = process.argv[2];
const speech = createQueueSpeech({ autostart: false });
try {
  let result;
  if (command === "status") result = await speech.status();
  else if (command === "stop") result = await speech.stopQueue();
  else if (command === "shutdown") result = await speech.shutdownWorker();
  else if (command === "mute") result = await speech.mute(process.argv[3]);
  else if (command === "unmute") result = await speech.unmute();
  else throw new Error("使用方法: node src/queue-cli.js status|stop|shutdown|mute hold|mute discard|unmute");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (error.code === "ECONNREFUSED" && command === "status") console.log(JSON.stringify({ running: false }));
  else { console.error(error.message); process.exitCode = 1; }
} finally { speech.stop(); }
