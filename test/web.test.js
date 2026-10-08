import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { startWeb } from "../src/web-server.js";

test("a fresh browser shows newest history first and places cleared active speech by acceptance time", async () => {
  const source = await readFile(new URL("../src/web/app.js", import.meta.url), "utf8");
    const elements = new Map(); let requests = 0; let poll;
    const node = () => ({ dataset: {}, children: [], append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; } });
    const element = (id) => {
      if (!elements.has(id)) elements.set(id, { ...node(), id, value: "", textContent: "", disabled: false, setAttribute() {}, addEventListener() {} });
      return elements.get(id);
    };
    vm.runInNewContext(source, {
      AbortSignal,
      document: { getElementById: element, createDocumentFragment: node, createElement: node, querySelectorAll: () => [], addEventListener() {}, hidden: false },
      matchMedia: () => ({ matches: true, addEventListener() {} }),
      fetch: async (url, options) => { if (url === "/api/state") requests++; assert.equal(options.headers.Authorization, undefined); return { ok: true, json: async () => url === "/api/voices" ? { voices: [] } : ({ state: { pending: 1, connections: 1, muted: false, settings: { voice: null, rate: 175 }, current: { jobId: "active", text: "earlier active speech", status: "playing", acceptedAt: 1 } }, history: { entries: [{ jobId: "pending", text: "later queued speech", status: "accepted", acceptedAt: 2 }] } }) }; },
      setInterval: (callback) => { poll = callback; },
    });
    await new Promise(setImmediate);
    poll(); poll(); await new Promise(setImmediate);
    assert.equal(requests, 2);
    assert.equal(element("connection").textContent, "接続済み");
    assert.equal(element("connection").dataset.state, "connected");
    assert.equal(element("error").textContent, "");
    assert.equal(element("hold").disabled, false);
    assert.equal(element("unmute").disabled, false);
    assert.equal(element("mute-state").hidden, true);
    assert.equal(element("mobile-mute-state").hidden, true);
    const rows = element("history-list").children[0].children;
    assert.equal(rows[0].children[1].children[0].textContent, "later queued speech");
    assert.equal(rows[1].className, "history-row is-current");
    assert.equal(rows[1].children[1].children[0].textContent, "earlier active speech");
});

test("desktop and mobile history keep newest additions above the active and older rows", async () => {
  const source = await readFile(new URL("../src/web/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../src/web/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /最新へ|href="#latest"|id="latest"|latest-link/);
  assert.doesNotMatch(html, /<h1>発話履歴と音声設定/);
  const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  for (const id of ["connection", "play-state", "pending", "clients", "clear"]) assert.match(header, new RegExp(`id="${id}"`));
  assert.match(html, /aria-label="新しい順の発話履歴"/);
  assert.doesNotMatch(html, /<footer|<nav|id="settings-link"|このMacで、声を整える/);
  assert.match(html, /id="open-settings"/);
  for (const desktop of [true, false]) {
    const elements = new Map(); let poll;
    const node = () => ({ dataset: {}, children: [], append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; } });
    const element = id => { if (!elements.has(id)) elements.set(id, { ...node(), id, value: "", setAttribute() {}, addEventListener() {} }); return elements.get(id); };
    const current = { jobId: "active", text: "active", status: "playing", acceptedAt: 2 };
    const entries = [{ jobId: "pending", text: "pending", status: "accepted", acceptedAt: 3 }, { ...current, status: "accepted" }, { jobId: "old", text: "old", status: "completed", acceptedAt: 1 }];
    vm.runInNewContext(source, { AbortSignal, document: { getElementById: element, createDocumentFragment: node, createElement: node, querySelectorAll: () => [], addEventListener() {}, hidden: false },
      matchMedia: () => ({ matches: desktop, addEventListener() {} }), setInterval: callback => { poll = callback; },
      fetch: async url => ({ ok: true, json: async () => url === "/api/voices" ? { voices: [] } : { state: { current, settings: { voice: null, rate: 175 } }, history: { entries } } }) });
    await new Promise(setImmediate);
    const rows = () => element("history-list").children[0].children;
    const texts = () => rows().map(row => row.children[1].children[0].textContent);
    assert.deepEqual(Array.from(texts()), ["pending", "active", "old"]);
    assert.equal(rows()[1].className, "history-row is-current"); assert.equal(rows()[1].dataset.status, "playing");
    entries.unshift({ jobId: "new", text: "new", status: "accepted", acceptedAt: 4 });
    poll(); await new Promise(setImmediate);
    assert.deepEqual(Array.from(texts()), ["new", "pending", "active", "old"]);
    entries.splice(2, 1);
    poll(); await new Promise(setImmediate);
    assert.deepEqual(Array.from(texts()), ["new", "pending", "active", "old"]);
    entries.length = 0;
    poll(); await new Promise(setImmediate);
    assert.deepEqual(Array.from(texts()), ["active"]);
  }
});

test("mute labels stay hidden normally and show mute, fault and connection failures", async () => {
  const source = await readFile(new URL("../src/web/app.js", import.meta.url), "utf8");
  const elements = new Map(); let poll; let offline = false;
  const state = { muted: false, settings: { voice: null, rate: 175 } };
  const node = () => ({ dataset: {}, children: [], append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; } });
  const element = id => { if (!elements.has(id)) elements.set(id, { ...node(), id, value: "", setAttribute() {}, addEventListener() {} }); return elements.get(id); };
  vm.runInNewContext(source, { AbortSignal, document: { getElementById: element, createDocumentFragment: node, createElement: node, querySelectorAll: () => [], addEventListener() {}, hidden: false },
    matchMedia: () => ({ matches: false, addEventListener() {} }), setInterval: callback => { poll = callback; },
    fetch: async url => { if (offline) throw new Error("接続テスト失敗"); return { ok: true, json: async () => url === "/api/voices" ? { voices: [] } : { state, history: { entries: [] } } }; } });
  await new Promise(setImmediate);
  for (const mode of ["hold", "discard"]) {
    state.muted = true; state.muteMode = mode; poll(); await new Promise(setImmediate);
    assert.equal(element("mute-state").hidden, false); assert.equal(element("mobile-mute-state").hidden, false);
    assert.equal(element("mute-state").textContent, mode === "hold" ? "保留ミュート中" : "破棄ミュート中");
    assert.equal(element("play-state").textContent, mode === "hold" ? "保留中" : "破棄中");
  }
  state.muted = false; state.fault = "安全停止の理由"; poll(); await new Promise(setImmediate);
  assert.equal(element("connection").textContent, "異常"); assert.equal(element("connection").dataset.state, "fault");
  assert.equal(element("mobile-mute-state").textContent, "安全停止"); assert.equal(element("error").hidden, false);
  offline = true; poll(); await new Promise(setImmediate);
  assert.equal(element("connection").textContent, "未接続"); assert.equal(element("connection").dataset.state, "disconnected");
  assert.equal(element("mute-state").hidden, false); assert.equal(element("mute-state").textContent, "状態不明");
  assert.equal(element("mobile-mute-state").textContent, "状態不明"); assert.equal(element("hold").disabled, true);
  offline = false; delete state.fault; poll(); await new Promise(setImmediate);
  assert.equal(element("mute-state").hidden, true); assert.equal(element("mobile-mute-state").hidden, true);
  assert.equal(element("error").hidden, true);
});

test("voice groups sort by language and name and preserve draft, system and unavailable selections", async () => {
  const source = await readFile(new URL("../src/web/app.js", import.meta.url), "utf8");
  for (const saved of ["Missing", null]) {
    const elements = new Map();
    const node = () => ({ dataset: {}, children: [], append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; } });
    const element = id => { if (!elements.has(id)) elements.set(id, { ...node(), id, value: "", setAttribute() {}, addEventListener() {} }); return elements.get(id); };
    let voices = [{ name: "Zoe", language: "en_US" }, { name: "Otoya", language: "ja_JP" }, { name: "Alice", language: "en_US" }, { name: "Kyoko", language: "ja_JP" }];
    const context = vm.createContext({ AbortSignal, document: { getElementById: element, createDocumentFragment: node, createElement: node, querySelectorAll: () => [], addEventListener() {}, hidden: false },
      matchMedia: () => ({ matches: true, addEventListener() {} }), setInterval() {},
      fetch: async url => ({ ok: true, json: async () => url === "/api/voices" ? { voices } : { state: { settings: { voice: saved, rate: 220 } }, history: { entries: [] } } }) });
    vm.runInContext(source, context); await new Promise(setImmediate);
    const options = () => element("voice").children[0].children;
    const groups = () => options().filter(option => option.label);
    const labels = new Intl.DisplayNames(["ja"], { type: "language" });
    const regions = new Intl.DisplayNames(["ja"], { type: "region" });
    assert.deepEqual(Array.from(groups(), group => group.label), [`${labels.of("en")}（${regions.of("US")}） · en_US`, `${labels.of("ja")}（${regions.of("JP")}） · ja_JP`]);
    assert.deepEqual(Array.from(groups()[0].children, option => option.value), ["Alice", "Zoe"]);
    assert.deepEqual(Array.from(groups()[1].children, option => option.value), ["Kyoko", "Otoya"]);
    assert.equal(options()[0].value, ""); assert.equal(element("voice").value, saved || "");
    if (saved) assert.equal(options().at(-1).textContent, "Missing（利用不可）");
    element("voice").value = "Zoe"; element("rate").value = "333";
    voices = [...voices].reverse(); await vm.runInContext("loadVoices()", context);
    assert.equal(element("voice").value, "Zoe"); assert.equal(element("rate").value, "333");
    voices = voices.filter(voice => voice.name !== "Zoe"); await vm.runInContext("loadVoices()", context);
    assert.equal(element("voice").value, "Zoe"); assert.equal(options().at(-1).textContent, "Zoe（利用不可）");
  }
});

test("saving settings reports failure without claiming success or losing the draft", async () => {
  const source = await readFile(new URL("../src/web/app.js", import.meta.url), "utf8");
  const elements = new Map(); let saves = 0;
  const node = () => ({ dataset: {}, children: [], handlers: {}, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, setAttribute() {}, addEventListener(type, handler) { this.handlers[type] = handler; } });
  const element = id => { if (!elements.has(id)) elements.set(id, { ...node(), id, value: "" }); return elements.get(id); };
  vm.runInNewContext(source, { AbortSignal, document: { getElementById: element, createDocumentFragment: node, createElement: node, querySelectorAll: () => [], addEventListener() {}, hidden: false },
    matchMedia: () => ({ matches: true, addEventListener() {} }), setInterval() {},
    fetch: async url => {
      if (url === "/api/settings") { saves++; return { ok: false, status: 503, json: async () => ({ error: "設定ファイルを保存できません" }) }; }
      return { ok: true, json: async () => url === "/api/voices" ? { voices: [{ name: "Kyoko", language: "ja_JP" }] } : { state: { settings: { voice: null, rate: 175 } }, history: { entries: [] } } };
    } });
  await new Promise(setImmediate);
  element("voice").value = "Kyoko"; element("voice").handlers.change();
  element("rate").value = "240"; element("rate").handlers.input();
  assert.equal(saves, 0); assert.match(element("voice-feedback").textContent, /まだ保存していません/);
  element("voice-form").handlers.submit({ preventDefault() {} }); await new Promise(setImmediate);
  assert.equal(saves, 1); assert.equal(element("voice-feedback").dataset.state, "error");
  assert.match(element("voice-feedback").textContent, /保存できません/);
  assert.match(element("applied-settings").textContent, /175/);
  assert.equal(element("voice").value, "Kyoko"); assert.equal(element("rate").value, "240");
});

test("mobile drawer keeps draft and scroll across close paths and desktop transitions without speech actions", async () => {
  const source = await readFile(new URL("../src/web/app.js", import.meta.url), "utf8");
  const elements = new Map(); const surfaces = [{ inert: false }, { inert: false }];
  const document = { hidden: false, body: { style: {}, classList: { add() {}, remove() {} } }, documentElement: { clientWidth: 375 }, addEventListener() {}, querySelectorAll: () => surfaces };
  const node = (id = "") => ({ id, dataset: {}, value: "", children: [], handlers: {}, attributes: {},
    append(...children) { for (const child of children) { if (child.parent) child.parent.children = child.parent.children.filter(n => n !== child); child.parent = this; this.children.push(child); } },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { document.activeElement = this; },
    contains(target) { return target === this || this.children.some(child => child.contains(target)); },
    querySelector() { return elements.get("hold"); },
    querySelectorAll() { return [get("close-settings"), get("hold"), get("rate"), get("preview"), get("save-settings")]; },
    getClientRects() { return [{}]; },
    showModal() { this.open = true; }, close() { this.open = false; this.handlers.close?.(); },
    getBoundingClientRect() { return { left: 16, right: 375, top: 0, bottom: 800 }; },
  });
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, node(id)); return elements.get(id); };
  document.createElement = document.createDocumentFragment = node;
  const get = document.getElementById;
  get("settings-home").append(get("settings-panel")); get("settings-panel").append(get("hold"));
  const window = { scrollX: 0, scrollY: 18000, scrollTo(x, y) { this.scrollX = x; this.scrollY = y; } };
  const media = { matches: false, addEventListener(type, handler) { this.change = handler; } };
  const calls = [];
  vm.runInNewContext(source, { document, window, matchMedia: () => media, AbortSignal, setInterval() {}, fetch: async (url, options) => {
    calls.push([url, options.method]); return { ok: true, json: async () => url === "/api/voices" ? { voices: [] } : { state: { muted: true, muteMode: "hold", settings: { voice: null, rate: 175 } }, history: { entries: [] } } };
  } });
  await new Promise(setImmediate);
  const open = () => { get("open-settings").focus(); get("open-settings").handlers.click(); };
  const assertClosed = () => {
    assert.equal(get("settings-dialog").open, false); assert.equal(get("settings-panel").parent, get("settings-home"));
    assert.equal(window.scrollY, 18000); assert.equal(document.body.style.top, ""); assert.ok(surfaces.every(n => !n.inert));
    assert.equal(get("rate").value, "333"); assert.equal(get("voice").value, "Kyoko");
  };
  get("rate").value = "333"; get("voice").value = "Kyoko";
  open(); assert.equal(document.body.style.top, "-18000px"); assert.ok(surfaces.every(n => n.inert)); assert.equal(document.activeElement, get("hold"));
  get("save-settings").focus(); get("settings-dialog").handlers.keydown({ key: "Tab", shiftKey: false, preventDefault() {} }); assert.equal(document.activeElement, get("close-settings"));
  get("settings-dialog").handlers.keydown({ key: "Tab", shiftKey: true, preventDefault() {} }); assert.equal(document.activeElement, get("save-settings"));
  get("settings-dialog").handlers.cancel({ preventDefault() {} }); assertClosed(); assert.equal(document.activeElement, get("open-settings"));
  open(); get("close-settings").handlers.click(); assertClosed();
  open(); get("settings-dialog").handlers.pointerdown({ clientX: 2, clientY: 400 }); get("settings-dialog").handlers.click({ clientX: 2, clientY: 400 }); assertClosed();
  open(); media.matches = true; media.change(); assertClosed(); assert.equal(document.activeElement, get("hold"));
  media.matches = false; media.change(); assert.equal(document.activeElement, get("open-settings"));
  assert.ok(calls.every(([, method]) => method === "GET"));
  assert.equal(get("mobile-mute-state").textContent, "保留中");
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
