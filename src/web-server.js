import http from "node:http";
import fs from "node:fs/promises";
import { createQueueSpeech } from "./queue-client.js";
import { parseVoices, validateSettings } from "./speech-settings.js";

const assets = new Map([
  ["/", ["./web/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["./web/app.js", "text/javascript; charset=utf-8"]],
  ["/app.css", ["./web/app.css", "text/css; charset=utf-8"]],
  ["/tokens.css", ["../tokens.css", "text/css; charset=utf-8"]],
]);

export async function startWeb({ port = Number(process.env.MCP_SPEAK_WEB_PORT || 44501),
  speech = createQueueSpeech(), identity, onLease } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Webポートが不正です");
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    const json = (status, value) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); };
    try {
      if (req.headers.host !== new URL(origin).host) return json(403, { error: "このホストからは接続できません" });
      if (req.headers.origin && req.headers.origin !== origin) return json(403, { error: "別のサイトからは操作できません" });
      if (req.method === "GET" && assets.has(req.url)) {
        const [name, mime] = assets.get(req.url);
        res.writeHead(200, { "Content-Type": mime });
        return res.end(await fs.readFile(new URL(name, import.meta.url)));
      }
      if (!req.url?.startsWith("/api/")) return json(404, { error: "画面が見つかりません" });
      if (req.method === "GET" && req.url === "/api/identity" && identity) return json(200, identity);
      if (req.method === "GET" && req.url === "/api/lease" && onLease) {
        if (req.headers.origin !== origin) return json(403, { error: "同じ受付から接続してください" });
        res.setHeader("X-MCP-Speak-Instance", identity.instanceId);
        onLease(res); res.writeHead(200, { "Content-Type": "application/json" }); res.write("{\"connected\":true}\n"); return;
      }
      if (req.method === "GET" && req.url === "/api/state") {
        const [state, history] = await Promise.all([speech.status(), speech.history()]);
        return json(200, { state, history });
      }
      if (req.method === "GET" && req.url === "/api/voices") return json(200, { voices: parseVoices(await speech.listVoices()) });
      if (req.method !== "POST" || !["/api/mute", "/api/unmute", "/api/clear-history", "/api/settings", "/api/preview"].includes(req.url)) return json(405, { error: "未対応の操作です" });
      if (req.headers.origin !== origin || req.headers["content-type"] !== "application/json") return json(403, { error: "同じ画面から操作してください" });
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 4096) return json(413, { error: "操作データが大きすぎます" });
      }
      let args;
      try { args = JSON.parse(body); } catch { return json(400, { error: "操作データが不正です" }); }
      if (!args || typeof args !== "object" || Array.isArray(args)) return json(400, { error: "操作データが不正です" });
      if (["/api/settings", "/api/preview"].includes(req.url)) {
        let selected;
        try { selected = validateSettings(args); } catch (error) { return json(400, { error: error.message }); }
        if (selected.voice !== null && !parseVoices(await speech.listVoices()).some((voice) => voice.name === selected.voice)) return json(400, { error: "このMacで利用できる音声を選んでください" });
        if (req.url === "/api/settings") return json(200, await speech.saveSettings(selected));
        return json(200, await speech.preview({ text: "こんにちは。音声と読み上げの速さを確認しています。", voice: selected.voice ?? undefined, rate: selected.rate }));
      }
      if (req.url === "/api/mute") {
        if (Object.keys(args).some((key) => key !== "mode") || !["hold", "discard"].includes(args.mode)) return json(400, { error: "ミュート方式が不正です" });
        return json(200, await speech.mute(args.mode));
      }
      if (Object.keys(args).length) return json(400, { error: "未対応の引数です" });
      return json(200, req.url === "/api/unmute" ? await speech.unmute() : await speech.clearHistory());
    } catch (error) { if (!res.headersSent) json(503, { error: `${error.message}。操作の自動再送はしません` }); else res.end(); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, url: `${origin}/`, async close() {
    speech.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  } };
}
