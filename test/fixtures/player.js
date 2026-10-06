import fs from "node:fs";
const eventFile = process.env.QUEUE_TEST_EVENTS;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  if (input === "fail") {
    fs.appendFileSync(eventFile, JSON.stringify({ type: "start", text: input, pid: process.pid, time: Date.now() }) + "\n");
    fs.appendFileSync(eventFile, JSON.stringify({ type: "end", text: input, pid: process.pid, time: Date.now() }) + "\n");
    process.exit(1);
  }
  const timer = setTimeout(() => end(0), ["hang", "ignore"].includes(input) ? 60000 : 150);
  function end(code) {
    clearTimeout(timer);
    fs.appendFileSync(eventFile, JSON.stringify({ type: "end", text: input, pid: process.pid, time: Date.now() }) + "\n");
    process.exit(code);
  }
  process.once("SIGTERM", () => { if (input !== "ignore") end(0); });
  // Tests may cancel as soon as they observe start; install the handler first.
  fs.appendFileSync(eventFile, JSON.stringify({ type: "start", text: input, pid: process.pid, time: Date.now() }) + "\n");
});
