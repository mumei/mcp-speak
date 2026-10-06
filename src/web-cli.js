import { startWeb } from "./web-server.js";

startWeb().then(({ url, close }) => {
  console.log(`MCP Speakの操作画面: ${url}`);
  console.log("認証付きURLは同じMacのブラウザで開き、他の人へ共有しないでください。終了はCtrl+Cです。");
  const stop = () => close().catch(console.error);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
