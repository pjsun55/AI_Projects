export const VERSION = '0.1.1';
export const DB_NAME = 'ios-pwa-lab-results';
export const CACHE_PREFIX = 'ios-pwa-lab:';
export const STATES = Object.freeze({
  untested: '未測試', success: '成功', failed: '失敗', unsupported: '不支援',
  cancelled: '使用者取消', condition: '缺少測試條件', backend: '待後端', native: '需原生',
});
export class Outcome extends Error {
  constructor(status, message) { super(message); this.name = 'Outcome'; this.status = status; }
}
export function classifyError(error) {
  if (error instanceof Outcome) return { status: error.status, summary: error.message };
  const name = error?.name || 'Error';
  const status = name === 'AbortError' ? 'cancelled'
    : ['NotAllowedError', 'SecurityError', 'NotFoundError', 'NotReadableError', 'InvalidStateError'].includes(name) || [1, 2, 3].includes(error?.code) ? 'condition'
    : name === 'NotSupportedError' ? 'unsupported' : 'failed';
  return { status, summary: `${name}: ${error?.message || String(error)}` };
}
export function mode(env = globalThis) {
  return env.navigator?.standalone || env.matchMedia?.('(display-mode: standalone)').matches ? 'pwa' : 'safari-tab';
}
// Only explicitly selected summaries are stored. Media and precise coordinates never enter reports.
export function makeResult({ id, status, summary, evidence = '操作', environment, device = {}, now = new Date() }) {
  if (!Object.hasOwn(STATES, status)) throw new TypeError('未知狀態');
  return { id: `${now.getTime()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`,
    testId: id, status, summary: String(summary).slice(0, 3000), evidence,
    version: VERSION, mode: environment.mode, secure: environment.secure,
    device: { model: String(device.model || '').slice(0, 80), ios: String(device.ios || '').slice(0, 40) },
    time: now.toISOString() };
}
export function report(results, format) {
  const data = { app: 'iOS PWA Lab', version: VERSION, exportedAt: new Date().toISOString(),
    note: 'API 偵測與操作不同；人工確認不等於自動驗證。不含媒體或完整定位座標。', results };
  if (format === 'json') return JSON.stringify(data, null, 2);
  const safe = value => String(value).replace(/[\r\n|]/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `# iOS PWA Lab 測試報告\n\n版本：${VERSION}\n匯出時間：${data.exportedAt}\n\n${data.note}\n\n| 時間 | 模式 | 裝置 / iOS | 測試 | 狀態 | 證據 | 摘要 |\n| --- | --- | --- | --- | --- | --- | --- |\n` +
    results.map(r => `| ${[r.time, r.mode, `${r.device.model} / ${r.device.ios}`, r.testId, STATES[r.status], r.evidence, r.summary].map(safe).join(' | ')} |`).join('\n');
}
export class Resources {
  constructor() { this.cleanups = []; this.generation = 0; }
  add(cleanup) { this.cleanups.push(cleanup); return cleanup; }
  stop() { this.generation++; for (const cleanup of this.cleanups.splice(0).reverse()) { try { cleanup()?.catch?.(() => {}); } catch {} } }
  async acquire(promise, release) {
    const generation = this.generation;
    const resource = await promise;
    if (generation !== this.generation) { release(resource)?.catch?.(() => {}); throw new Outcome('cancelled', '操作已停止；遲到的資源已釋放'); }
    this.add(() => release(resource)); return resource;
  }
}
