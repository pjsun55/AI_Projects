// A screen lock belongs to one foreground conversion, never to saved data.
export function holdScreenAwake({ signal, wakeLock = globalThis.navigator?.wakeLock, visible = () => !globalThis.document?.hidden, onChange = () => {} } = {}) {
  let sentinel = null, stopped = false;
  async function relinquish(lock) {
    try { if (!lock.released) await lock.release(); }
    catch { onChange('release-failed'); }
  }
  function release() {
    if (stopped) return Promise.resolve();
    stopped = true;
    signal?.removeEventListener('abort', release);
    const held = sentinel; sentinel = null;
    onChange('idle');
    return held ? relinquish(held) : Promise.resolve();
  }
  if (signal?.aborted) return { release, ready: Promise.resolve() };
  signal?.addEventListener('abort', release, { once: true });
  const ready = (async () => {
    if (!wakeLock?.request || !visible()) { onChange('unavailable'); return; }
    onChange('requesting');
    try {
      const granted = await wakeLock.request('screen');
      // A cancelled job may receive its lock after another job has started.
      if (stopped || signal?.aborted || !visible()) { await relinquish(granted); return; }
      sentinel = granted;
      granted.addEventListener('release', () => { if (!stopped) onChange('released'); }, { once: true });
      onChange(granted.released ? 'released' : 'active');
    } catch { if (!stopped) onChange('unavailable'); }
  })();
  return { ready, release };
}
