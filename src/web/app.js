const $ = (id) => document.getElementById(id);
let connected = false;
let busy = false;
let reading = false;
let actionError = "";
let initialized = false;
let voicesLoaded = false;
let loadingVoices = false;
let desiredVoice = "";
let voices = [];
const names = { accepted: "受付済み・待機", preparing: "再生準備", playing: "再生中", completed: "再生完了", failed: "失敗", discarded: "破棄", cancelled: "停止・取消" };
const buttons = [$("hold"), $("discard"), $("unmute"), $("clear"), $("preview"), $("save-settings")];
function enabled() {
  for (const button of buttons) { button.disabled = !connected || busy || (["preview", "save-settings"].includes(button.id) && (!voicesLoaded || !initialized)); button.setAttribute("aria-busy", String(busy)); }
  $("voice").disabled = !connected || !voicesLoaded || !initialized;
  $("rate").disabled = $("rate-slider").disabled = !connected || !initialized;
  $("reload-voices").disabled = loadingVoices || busy;
  $("reload-voices").setAttribute("aria-busy", String(loadingVoices));
}
function error(message) { $("error").textContent = message; $("error").hidden = !message; }
function feedback(message, state = "") { $("voice-feedback").textContent = message; $("voice-feedback").dataset.state = state; }
function voiceOptions() {
  const options = document.createDocumentFragment();
  const add = (value, label) => { const option = document.createElement("option"); option.value = value; option.textContent = label; options.append(option); };
  add("", "Macの既定音声");
  for (const voice of voices) add(voice.name, `${voice.name} · ${voice.language}`);
  if (desiredVoice && !voices.some((voice) => voice.name === desiredVoice)) add(desiredVoice, `${desiredVoice}（利用不可）`);
  $("voice").replaceChildren(options); $("voice").value = desiredVoice;
}
async function loadVoices() {
  if (loadingVoices) return;
  loadingVoices = true; enabled();
  try {
    const result = await api("voices"); voices = result.voices;
    desiredVoice = initialized ? $("voice").value : desiredVoice;
    voiceOptions(); voicesLoaded = true;
    $("voice-help").textContent = "利用可能な音声のみ。音声の追加ダウンロードは行いません。";
    $("reload-voices").hidden = true;
  } catch (err) {
    voicesLoaded = false; $("voice-help").textContent = `音声一覧を取得できません: ${err.message}。再取得してください。`;
    $("reload-voices").hidden = false;
  } finally { loadingVoices = false; enabled(); }
}
function selection() {
  const rate = Number($("rate").value);
  if (!Number.isInteger(rate) || rate < 1 || rate > 500) throw new Error("速度は1〜500の整数を入力してください");
  const voice = $("voice").value || null;
  if (voice && !voices.some((item) => item.name === voice)) throw new Error("このMacで利用できる音声を選んでください");
  return { voice, rate };
}
async function api(path, args) {
  const response = await fetch(`/api/${path}`, { method: args ? "POST" : "GET", headers: args ? { "Content-Type": "application/json" } : {}, body: args ? JSON.stringify(args) : undefined, signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) { const failure = new Error(result.error); failure.status = response.status; throw failure; }
  return result;
}
function render({ state, history }) {
  $("connection").textContent = "共有ワーカーに接続中";
  $("pending").textContent = state.pending;
  $("clients").textContent = state.connections;
  $("play-state").textContent = state.fault ? "安全停止" : state.current ? names[state.current.status] : state.muted ? "ミュート中" : "待機中";
  $("mute-state").textContent = state.muted ? state.muteMode === "hold" ? "保留ミュート中" : "破棄ミュート中" : "ミュート解除中";
  $("hold").setAttribute("aria-pressed", String(state.muted && state.muteMode === "hold"));
  $("discard").setAttribute("aria-pressed", String(state.muted && state.muteMode === "discard"));
  $("preview-help").textContent = state.muted ? state.muteMode === "hold" ? "保留ミュート中の試聴は待機します。解除はご自身で操作してください。" : "破棄ミュート中の試聴は破棄され、音は出ません。" : "試聴も共有キューに並びます。設定の保存は行いません。";
  if (state.settings) {
    $("applied-settings").textContent = `保存済み: ${state.settings.voice || "Macの既定音声"} · ${state.settings.rate} 単語/分`;
    if (!initialized) {
      desiredVoice = state.settings.voice || ""; $("rate").value = $("rate-slider").value = state.settings.rate;
      voiceOptions(); initialized = true;
    }
  } else throw new Error("ワーカーを更新・再起動してください。音声設定に対応していません");
  const list = document.createDocumentFragment();
  const entries = [...history.entries].reverse();
  if (state.current && !entries.some((entry) => entry.jobId === state.current.jobId)) entries.unshift(state.current);
  for (const item of entries) {
    const current = state.current?.jobId === item.jobId;
    const entry = current ? state.current : item;
    const row = document.createElement("li"); row.className = current ? "history-row is-current" : "history-row";
    row.dataset.status = entry.status;
    const meta = document.createElement("div"); meta.className = "history-meta";
    const time = document.createElement("span"); time.textContent = new Date(entry.acceptedAt).toLocaleTimeString("ja-JP");
    const status = document.createElement("span"); status.className = "status"; status.textContent = names[entry.status] || entry.status;
    const kind = document.createElement("span"); kind.textContent = entry.kind === "preview" ? "試聴" : "読み上げ";
    meta.append(kind, time, status);
    const content = document.createElement("div");
    const text = document.createElement("p"); text.textContent = entry.text + (entry.truncated ? "…（先頭512文字）" : "");
    content.append(text);
    if (entry.rate) { const settings = document.createElement("p"); settings.className = "history-voice"; settings.textContent = `${entry.voice || "Macの既定音声"} · ${entry.rate} 単語/分`; content.append(settings); }
    if (entry.error) { const reason = document.createElement("p"); reason.className = "reason"; reason.textContent = entry.error; content.append(reason); }
    row.append(meta, content); list.append(row);
  }
  $("history-list").replaceChildren(list); $("empty").hidden = entries.length > 0;
  error(state.fault || actionError);
}
async function refresh() {
  if (reading || busy) return;
  reading = true;
  try { render(await api("state")); connected = true; }
  catch (err) {
    connected = false; $("connection").textContent = "接続できません・再確認中";
    $("play-state").textContent = "状態不明・履歴は最後に取得した表示";
    $("pending").textContent = "—"; $("clients").textContent = "—"; $("mute-state").textContent = "状態不明";
    error(`${err.message}。起動時のURLとWebプロセスを確認してください。`);
  } finally { reading = false; enabled(); }
}
async function act(path, args = {}) {
  if (busy || !connected) return;
  busy = true; enabled(); actionError = ""; error(""); $("connection").textContent = "操作の結果を確認中";
  try {
    const result = await api(path, args);
    if (path === "settings") feedback(`保存済み: ${result.voice || "Macの既定音声"} · ${result.rate} 単語/分`, "success");
    if (path === "preview") feedback(result.discarded ? "破棄ミュートのため試聴を破棄しました。" : result.muted ? "試聴を保留しました。ミュート解除後に順番に再生します。" : "試聴を受け付けました。左の履歴で再生結果を確認できます。", "success");
  }
  catch (err) { actionError = `${err.message}。状態を確認してから操作してください。自動再送はしません。`; error(actionError); if (["settings", "preview"].includes(path)) feedback(actionError, "error"); }
  finally { busy = false; enabled(); await refresh(); }
}
$("hold").addEventListener("click", () => act("mute", { mode: "hold" }));
$("discard").addEventListener("click", () => act("mute", { mode: "discard" }));
$("unmute").addEventListener("click", () => act("unmute"));
function voiceAction(path) {
  try { const args = selection(); $("rate").setAttribute("aria-invalid", "false"); void act(path, args); }
  catch (err) { $("rate").setAttribute("aria-invalid", String(!Number.isInteger(Number($("rate").value)) || Number($("rate").value) < 1 || Number($("rate").value) > 500)); feedback(err.message, "error"); }
}
$("voice-form").addEventListener("submit", (event) => { event.preventDefault(); voiceAction("settings"); });
$("preview").addEventListener("click", () => voiceAction("preview"));
$("reload-voices").addEventListener("click", () => void loadVoices());
$("rate-slider").addEventListener("input", () => { $("rate").value = $("rate-slider").value; $("rate").setAttribute("aria-invalid", "false"); feedback("変更はまだ保存していません。"); });
$("rate").addEventListener("input", () => { const rate = Number($("rate").value); if (Number.isInteger(rate) && rate >= 1 && rate <= 500) $("rate-slider").value = rate; feedback("変更はまだ保存していません。"); });
$("rate").addEventListener("blur", () => { const valid = Number.isInteger(Number($("rate").value)) && Number($("rate").value) >= 1 && Number($("rate").value) <= 500; $("rate").setAttribute("aria-invalid", String(!valid)); $("rate-help").textContent = valid ? "初期値175。数値でも調整できます。" : "速度は1〜500の整数を入力してください。"; });
$("voice").addEventListener("change", () => { desiredVoice = $("voice").value; feedback("変更はまだ保存していません。"); });
$("clear").addEventListener("click", () => { $("confirmation").value = ""; $("confirm-clear").disabled = true; $("clear-dialog").showModal(); });
$("close-dialog").addEventListener("click", () => $("clear-dialog").close());
$("confirmation").addEventListener("input", () => { $("confirm-clear").disabled = $("confirmation").value !== "消去"; });
$("clear-form").addEventListener("submit", (event) => { event.preventDefault(); if ($("confirmation").value !== "消去") return; $("clear-dialog").close(); void act("clear-history"); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
void refresh();
void loadVoices();
setInterval(() => { if (!document.hidden) void refresh(); }, 1000);
