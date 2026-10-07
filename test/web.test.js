import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { startWeb } from "../src/web-server.js";

test("a fresh browser polls without keys and keeps cleared active speech before later history", async () => {
  const source = await readFile(new URL("../src/web/app.js", import.meta.url), "utf8");
    const elements = new Map(); let requests = 0; let poll;
    const node = () => ({ dataset: {}, children: [], append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; } });
    const element = (id) => {
      if (!elements.has(id)) elements.set(id, { ...node(), id, value: "", textContent: "", disabled: false, setAttribute() {}, addEventListener() {} });
      return elements.get(id);
    };
    vm.runInNewContext(source, {
      AbortSignal,
      document: { getElementById: element, createDocumentFragment: node, createElement: node, addEventListener() {}, hidden: false },
      fetch: async (url, options) => { if (url === "/api/state") requests++; assert.equal(options.headers.Authorization, undefined); return { ok: true, json: async () => url === "/api/voices" ? { voices: [] } : ({ state: { pending: 1, connections: 1, muted: false, settings: { voice: null, rate: 175 }, current: { jobId: "active", text: "earlier active speech", status: "playing", acceptedAt: 1 } }, history: { entries: [{ jobId: "pending", text: "later queued speech", status: "accepted", acceptedAt: 2 }] } }) }; },
      setInterval: (callback) => { poll = callback; },
    });
    await new Promise(setImmediate);
    poll(); poll(); await new Promise(setImmediate);
    assert.equal(requests, 2);
    assert.equal(element("connection").textContent, "共有ワーカーに接続中");
    assert.equal(element("error").textContent, "");
    assert.equal(element("hold").disabled, false);
    assert.equal(element("unmute").disabled, false);
    const rows = element("history-list").children[0].children;
    assert.equal(rows[0].className, "history-row is-current");
    assert.equal(rows[0].children[1].children[0].textContent, "earlier active speech");
    assert.equal(rows[1].children[1].children[0].textContent, "later queued speech");
});

test("Web API needs no key but retains exact Host and same Origin for controls", async (t) => {
  const calls = [];
  const speech = {
    status: async () => ({ muted: false }), history: async () => ({ entries: [] }),
    mute: async (mode) => { calls.push(mode); return { muted: true, muteMode: mode }; },
    unmute: async () => { calls.push("unmute"); return { muted: false }; },
    clearHistory: async () => { calls.push("clear"); return { cleared: true }; }, stop() {},
  };
  const web = await startWeb({ port: 0, speech });
  t.after(() => web.close());
  const headers = { Origin: web.origin, "Content-Type": "application/json" };
  assert.equal(web.server.address().address, "127.0.0.1");
  assert.equal(web.url, `${web.origin}/`);
  assert.equal((await fetch(`${web.origin}/api/state`)).status, 200);
  assert.equal((await fetch(`${web.origin}/api/state`, { headers: { Origin: "https://evil.example" } })).status, 403);
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
  const web = await startWeb({ port: 0, speech: {
    mute: async () => { count++; throw new Error("返信を確認できません"); }, stop() {},
  } });
  t.after(() => web.close());
  const response = await fetch(`${web.origin}/api/mute`, { method: "POST", headers: { Origin: web.origin, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "hold" }) });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /自動再送はしません/);
  assert.equal(count, 1);
});

test("voice settings and preview APIs validate installed names, JSON and Origin without auto-unmuting", async (t) => {
  const calls = [];
  const web = await startWeb({ port: 0, speech: {
    listVoices: async () => "Kyoko ja_JP # こんにちは。\nEddy (English (US)) en_US # Hello!\n",
    saveSettings: async (args) => { calls.push(["save", args]); return args; },
    preview: async (args) => { calls.push(["preview", args]); return { discarded: true }; },
    unmute: async () => { throw new Error("must never unmute"); }, stop() {},
  } });
  t.after(() => web.close());
  assert.equal((await (await fetch(`${web.origin}/api/voices`)).json()).voices.length, 2);
  const post = (route, args, extra = {}) => fetch(`${web.origin}/api/${route}`, { method: "POST", headers: { Origin: web.origin, "Content-Type": "application/json", ...extra }, body: JSON.stringify(args) });
  assert.equal((await post("settings", { voice: "Kyoko", rate: 220 })).status, 200);
  assert.equal((await post("preview", { voice: null, rate: 150 })).status, 200);
  assert.equal(calls[1][1].voice, undefined); assert.equal(calls[1][1].rate, 150);
  assert.match(calls[1][1].text, /こんにちは/);
  for (const route of ["settings", "preview"]) {
    assert.equal((await post(route, { voice: "missing", rate: 175 })).status, 400);
    assert.equal((await post(route, { voice: null, rate: 501 })).status, 400);
    assert.equal((await post(route, { voice: null, rate: 175, text: "arbitrary" })).status, 400);
    assert.equal((await post(route, { voice: null, rate: 175 }, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await post(route, { voice: null, rate: 175 }, { Origin: "" })).status, 403);
    assert.equal((await post(route, { voice: null, rate: 175 }, { "Content-Type": "text/plain" })).status, 403);
  }
  assert.equal(calls.length, 2);
});
