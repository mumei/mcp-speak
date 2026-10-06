import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { startWeb } from "../src/web-server.js";

test("missing and expired browser authentication stop reads and explain how to open the tab", async () => {
  const source = await readFile(new URL("../src/web/app.js", import.meta.url), "utf8");
  for (const savedToken of ["", "expired"]) {
    const elements = new Map(); let requests = 0; let poll;
    const element = (id) => {
      if (!elements.has(id)) elements.set(id, { textContent: "", disabled: false, setAttribute() {}, addEventListener() {}, replaceChildren() {} });
      return elements.get(id);
    };
    vm.runInNewContext(source, {
      URLSearchParams, AbortSignal, location: { hash: "", pathname: "/" },
      sessionStorage: { getItem: () => savedToken }, history: {},
      document: { getElementById: element, addEventListener() {}, hidden: false },
      window: { addEventListener() {} },
      fetch: async () => { requests++; return { ok: false, status: 401, json: async () => ({ error: "認証付きURLで開いてください" }) }; },
      setInterval: (callback) => { poll = callback; },
    });
    await new Promise(setImmediate);
    poll(); poll(); await new Promise(setImmediate);
    assert.equal(requests, savedToken ? 1 : 0);
    assert.equal(element("connection").textContent, "認証が必要です");
    assert.match(element("current-text").textContent, /このタブで開いて/);
    assert.match(element("error").textContent, /再試行しません/);
    assert.equal(element("hold").disabled, true);
    assert.equal(element("unmute").disabled, true);
  }
});

test("Web API requires its own token, exact Host and same Origin for controls", async (t) => {
  const calls = [];
  const speech = {
    status: async () => ({ muted: false }), history: async () => ({ entries: [] }),
    mute: async (mode) => { calls.push(mode); return { muted: true, muteMode: mode }; },
    unmute: async () => { calls.push("unmute"); return { muted: false }; },
    clearHistory: async () => { calls.push("clear"); return { cleared: true }; }, stop() {},
  };
  const web = await startWeb({ port: 0, token: "a".repeat(64), speech });
  t.after(() => web.close());
  const headers = { Authorization: `Bearer ${"a".repeat(64)}`, Origin: web.origin, "Content-Type": "application/json" };
  assert.equal(web.server.address().address, "127.0.0.1");
  assert.equal((await fetch(`${web.origin}/api/state`)).status, 401);
  assert.equal((await fetch(`${web.origin}/api/state`, { headers: { ...headers, Authorization: "Bearer bad" } })).status, 401);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.get(`${web.origin}/api/state`, { headers: { ...headers, Host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
  });
  assert.equal(wrongHost, 403);
  const post = (path, extra = {}, body = {}) => fetch(`${web.origin}/api/${path}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post("mute", { Origin: "https://evil.example" }, { mode: "discard" })).status, 403);
  assert.equal((await post("mute", { Origin: "" }, { mode: "hold" })).status, 403);
  assert.equal((await post("mute", { "Content-Type": "text/plain" }, { mode: "hold" })).status, 403);
  assert.equal((await post("mute", {}, { mode: "invalid" })).status, 400);
  assert.equal((await post("mute", {}, { mode: "hold" })).status, 200);
  assert.equal((await post("mute", {}, { mode: "discard" })).status, 200);
  assert.equal((await post("unmute")).status, 200);
  assert.equal((await post("clear-history")).status, 200);
  assert.deepEqual(calls, ["hold", "discard", "unmute", "clear"]);
  assert.equal((await post("mute", {}, { mode: "hold", padding: "x".repeat(5000) })).status, 413);
  const page = await fetch(web.origin);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  const js = await (await fetch(`${web.origin}/app.js`)).text();
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|eval\(/);
  assert.match(js, /textContent/);
  assert.equal((await fetch(`${web.origin}/../package.json`)).status, 404);
});

test("lost control response is reported without repeating the operation", async (t) => {
  let count = 0;
  const web = await startWeb({ port: 0, token: "b".repeat(64), speech: {
    mute: async () => { count++; throw new Error("返信を確認できません"); }, stop() {},
  } });
  t.after(() => web.close());
  const response = await fetch(`${web.origin}/api/mute`, { method: "POST", headers: { Authorization: `Bearer ${"b".repeat(64)}`, Origin: web.origin, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "hold" }) });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /自動再送はしません/);
  assert.equal(count, 1);
});
