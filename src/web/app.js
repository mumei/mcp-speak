const $ = (id) => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get("token") || sessionStorage.getItem("mcp-speak-web-token") || "";
if (fragment.has("token")) {
  sessionStorage.setItem("mcp-speak-web-token", token);
  history.replaceState(null, "", location.pathname);
}
let connected = false;
let busy = false;
let reading = false;
let actionError = "";
let authBlocked = !token;
const names = { accepted: "受付済み・待機", preparing: "再生準備", playing: "再生中", completed: "再生完了", failed: "失敗", discarded: "破棄", cancelled: "停止・取消" };
const buttons = [$("hold"), $("discard"), $("unmute"), $("clear")];
function enabled() { for (const button of buttons) { button.disabled = !connected || busy; button.setAttribute("aria-busy", String(busy)); } }
function error(message) { $("error").textContent = message; $("error").hidden = !message; }
async function api(path, args) {
  const response = await fetch(`/api/${path}`, { method: args ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, ...(args ? { "Content-Type": "application/json" } : {}) }, body: args ? JSON.stringify(args) : undefined, signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) { const failure = new Error(result.error); failure.status = response.status; throw failure; }
  return result;
}
function render({ state, history }) {
  $("connection").textContent = "共有ワーカーに接続中";
  $("pending").textContent = state.pending;
  $("clients").textContent = state.connections;
  $("play-state").textContent = state.fault ? "安全停止" : state.current ? names[state.current.status] : state.muted ? "ミュート中" : "待機中";
  $("current-text").textContent = state.current?.text || (state.muted ? "ミュート中です。現在の再生はありません。" : "現在の再生はありません。MCPクライアントからの依頼を待っています。");
  $("mute-state").textContent = state.muted ? state.muteMode === "hold" ? "保留ミュート中" : "破棄ミュート中" : "ミュート解除中";
  $("hold").setAttribute("aria-pressed", String(state.muted && state.muteMode === "hold"));
  $("discard").setAttribute("aria-pressed", String(state.muted && state.muteMode === "discard"));
  const list = document.createDocumentFragment();
  for (const entry of history.entries) {
    const row = document.createElement("li"); row.className = "history-row";
    const meta = document.createElement("div"); meta.className = "history-meta";
    const time = document.createElement("span"); time.textContent = new Date(entry.acceptedAt).toLocaleTimeString("ja-JP");
    const status = document.createElement("span"); status.className = "status"; status.textContent = names[entry.status] || entry.status;
    meta.append(time, status);
    const content = document.createElement("div");
    const text = document.createElement("p"); text.textContent = entry.text + (entry.truncated ? "…（先頭512文字）" : "");
    content.append(text);
    if (entry.error) { const reason = document.createElement("p"); reason.className = "reason"; reason.textContent = entry.error; content.append(reason); }
    row.append(meta, content); list.append(row);
  }
  $("history-list").replaceChildren(list); $("empty").hidden = history.entries.length > 0;
  error(state.fault || actionError);
}
function requireAuthentication() {
  connected = false; authBlocked = true;
  $("connection").textContent = "認証が必要です";
  $("play-state").textContent = "未認証"; $("mute-state").textContent = "未認証";
  $("current-text").textContent = "起動したターミナルに表示された認証付きURLを、このタブで開いてください。通常のURLだけでは接続できません。";
  $("pending").textContent = "—"; $("clients").textContent = "—";
  $("history-list").replaceChildren(); $("empty").hidden = true;
  error("新しいタブやWebプロセスの再起動後は、起動時の認証付きURLが必要です。認証が完了するまで再試行しません。");
  enabled();
}
async function refresh() {
  if (authBlocked) { requireAuthentication(); return; }
  if (reading || busy) return;
  reading = true;
  try { render(await api("state")); connected = true; }
  catch (err) {
    if (err.status === 401) { requireAuthentication(); return; }
    connected = false; $("connection").textContent = "接続できません・再確認中";
    $("play-state").textContent = "状態不明"; $("current-text").textContent = "接続を確認できません。履歴は最後に取得した表示です。";
    $("pending").textContent = "—"; $("clients").textContent = "—"; $("mute-state").textContent = "状態不明";
    error(`${err.message}。起動時のURLとWebプロセスを確認してください。`);
  } finally { reading = false; enabled(); }
}
async function act(path, args = {}) {
  if (busy || !connected) return;
  busy = true; enabled(); actionError = ""; error(""); $("connection").textContent = "操作の結果を確認中";
  try { await api(path, args); }
  catch (err) { actionError = `${err.message}。状態を確認してから操作してください。自動再送はしません。`; error(actionError); }
  finally { busy = false; enabled(); await refresh(); }
}
$("hold").addEventListener("click", () => act("mute", { mode: "hold" }));
$("discard").addEventListener("click", () => act("mute", { mode: "discard" }));
$("unmute").addEventListener("click", () => act("unmute"));
$("clear").addEventListener("click", () => { $("confirmation").value = ""; $("confirm-clear").disabled = true; $("clear-dialog").showModal(); });
$("close-dialog").addEventListener("click", () => $("clear-dialog").close());
$("confirmation").addEventListener("input", () => { $("confirm-clear").disabled = $("confirmation").value !== "消去"; });
$("clear-form").addEventListener("submit", (event) => { event.preventDefault(); if ($("confirmation").value !== "消去") return; $("clear-dialog").close(); void act("clear-history"); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
window.addEventListener("hashchange", () => {
  const incoming = new URLSearchParams(location.hash.slice(1));
  if (!incoming.has("token")) return;
  token = incoming.get("token") || "";
  sessionStorage.setItem("mcp-speak-web-token", token);
  history.replaceState(null, "", location.pathname);
  authBlocked = !token;
  void refresh();
});
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 1000);
