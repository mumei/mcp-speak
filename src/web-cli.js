import { holdWeb, runWebDaemon } from "./web-runtime.js";

if (process.argv.includes("--daemon")) {
  runWebDaemon().then(({ close }) => {
    const stop = () => close().catch(console.error);
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  }).catch((error) => { if (error.code !== "EADDRINUSE") console.error(error.message); process.exitCode = 1; });
} else {
  let lastInstance;
  const owner = holdWeb({ onReady: ({ url, instanceId }) => {
    if (instanceId === lastInstance) return;
    lastInstance = instanceId;
    console.log(`MCP Speakの操作画面: ${url}`);
    console.log("同じMacのブラウザで開いてください。終了はCtrl+Cです。");
  } });
  process.once("SIGINT", () => owner.stop()); process.once("SIGTERM", () => owner.stop());
  owner.ready.catch((error) => { console.error(error.message); owner.stop(); process.exitCode = 1; });
}
