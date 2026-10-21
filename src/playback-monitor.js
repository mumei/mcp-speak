// A close event can be delayed by inherited stdio. Polling also covers a lost
// event after suspend; only ESRCH is proof of death (EPERM is not).
export function monitorExit(child, done, {
  probe = (pid) => process.kill(pid, 0),
  every = setInterval,
  clear = clearInterval,
} = {}) {
  let settled = false;
  let timer;
  const dispose = () => {
    settled = true;
    clear(timer);
    child.removeListener("exit", finish);
    child.removeListener("close", finish);
  };
  function finish(code, signal) {
    if (settled) return;
    dispose();
    done(code, signal);
  }
  child.once("exit", finish);
  child.once("close", finish);
  timer = every(() => {
    if (settled) return;
    if (child.exitCode != null || child.signalCode != null) return finish(child.exitCode, child.signalCode);
    if (!child.pid) return;
    try { probe(child.pid); }
    catch (error) { if (error.code === "ESRCH") finish(null, null); }
  }, 250);
  timer.unref?.();
  return dispose;
}

export function waitForGuard(guard, { playbackMs, cancel, onMessage, start }, {
  later = setTimeout,
  clear = clearTimeout,
  monitor = monitorExit,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let watchdog;
    let stopMonitoring;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clear(watchdog);
      stopMonitoring?.();
      guard.removeListener("message", onMessage);
      guard.removeListener("error", finish);
      error ? reject(error) : resolve();
    };
    guard.on("message", onMessage);
    guard.on("error", finish);
    stopMonitoring = monitor(guard, () => finish());
    watchdog = later(() => {
      // On wake the worker timer may run before the guard's timeout/exit.
      // Give the owned guard a fresh cleanup window before declaring a fault.
      cancel();
      if (!settled) watchdog = later(() => finish(new Error("再生ガードの終了を確認できません。安全のため共有キューを停止しました")), 5000);
    }, playbackMs + 5000);
    try { start((error) => { if (error) finish(error); }); }
    catch (error) { finish(error); }
  });
}
