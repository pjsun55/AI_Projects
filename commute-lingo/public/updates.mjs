export function reloadVersion(location, version) {
  const target = new URL(location.href);
  target.search = new URLSearchParams({ v: version });
  // Replacing an identical URL with a fragment can keep the old document.
  // Shell-only revisions therefore need an explicit full reload.
  if (target.href === location.href) location.reload();
  else location.replace(target.href);
}

export function workerMessage(worker, message, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = () => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); };
    const timer = setTimeout(() => { finish(); reject(new Error('更新回應逾時，請稍後重試。')); }, timeout);
    channel.port1.onmessage = ({ data }) => { finish(); resolve(data); };
    try { worker.postMessage(message, [channel.port2]); }
    catch (error) { finish(); reject(error); }
  });
}

export function createUpdater({ serviceWorker, version, isAuto, canUpdate, prepare, lock, render, reload, visible = () => true, now = Date.now, timers = globalThis, message = workerMessage }) {
  let registration, starting, checking = false, applying = false, stopped = false, timer, activationTimer, lastCheck = -Infinity, candidate;
  const report = text => render({ text, waiting: !!registration?.waiting, applying, checking });
  async function apply() {
    const worker = registration?.waiting;
    if (!worker || applying || stopped) return;
    if (!canUpdate()) { report('新版已下載；播放、處理或編輯結束後即可更新。'); return; }
    applying = true; lock(true); report('正在保存進度並套用新版…');
    try {
      await prepare();
      const info = await message(worker, { type: 'CACHE_VERSION' });
      if (info?.ready !== true || info.updateProtocol !== 1 || !/^\d+\.\d+\.\d+$/.test(info.version)) throw new Error('新版尚未可套用；請關閉其他舊分頁後重新開啟。');
      candidate = info.version;
      const result = await message(worker, { type: 'APPLY_UPDATE' });
      if (result?.ok !== true) throw new Error(result?.reason === 'other-clients' ? '請先關閉其他通勤學語言分頁或視窗，再套用更新。' : '新版快取尚未就緒，請稍後重試。');
      // controllerchange may arrive before the reply above.
      if (applying) activationTimer = timers.setTimeout(() => {
        applying = false; lock(false); report('更新未完成；收藏仍保留，可再次檢查。');
      }, 10000);
    } catch (error) { applying = false; candidate = undefined; lock(false); report(error.message); }
  }
  async function refresh() {
    if (!registration || applying || stopped) return;
    if (registration.waiting) {
      report('新版已下載，可套用更新。');
      if (isAuto() && visible()) await apply();
    } else if (registration.installing) report('正在下載新版，完成後即可套用。');
  }
  function watch() {
    registration.installing?.addEventListener('statechange', () => { timers.setTimeout(() => { void refresh(); }, 0); });
    void refresh();
  }
  async function start() {
    if (registration) return registration;
    if (!serviceWorker) { report('此瀏覽器未提供版本更新支援。'); return; }
    if (!starting) starting = (async () => {
      registration = await serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
      registration.addEventListener('updatefound', watch); watch();
      schedule(); return registration;
    })().catch(error => { starting = undefined; report('無法檢查更新，請確認網路後重試。'); throw error; });
    return starting;
  }
  async function check() {
    if (checking || applying || stopped) return;
    checking = true; report('正在檢查新版…');
    try {
      const worker = await start();
      if (!worker) return;
      await worker.update(); lastCheck = now();
      if (worker.waiting || worker.installing) await refresh();
      else report(`目前已是最新版本 ${version}。`);
    } catch { report('檢查更新失敗；請確認網路後重試。'); }
    finally { checking = false; render({ checking, applying, waiting: !!registration?.waiting }); }
  }
  function schedule() {
    if (stopped) return;
    timer = timers.setTimeout(async () => {
      if (visible() && isAuto()) {
        if (now() - lastCheck >= 15 * 60 * 1000) await check();
        else await refresh();
      }
      schedule();
    }, 15000);
  }
  const controlled = () => {
    if (!applying || !candidate) return;
    timers.clearTimeout(activationTimer); applying = false;
    reload(candidate);
  };
  serviceWorker?.addEventListener('controllerchange', controlled);
  return { start, check, apply, refresh, stop() {
    stopped = true; timers.clearTimeout(timer); timers.clearTimeout(activationTimer);
    serviceWorker?.removeEventListener('controllerchange', controlled);
  } };
}
