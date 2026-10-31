import * as storage from './storage.mjs?v=0.2.34';
import { GEMINI_KEY, decryptApiKey } from './key-vault.mjs?v=0.2.34';
import { articleItems, articleSource, articleFingerprint, articleBatches, savedTranslations } from './article.mjs?v=0.2.34';
import { translateArticleBatch } from './gemini.mjs?v=0.2.34';

export function createArticleController({ getLibrary, getCurrent, available, changed, notify, broadcast }) {
  const records = new Map(); let active, epoch = 0, statusTimer;
  const current = () => { const track = getCurrent(); return savedTranslations(records.get(track?.id), track); };
  function render() {
    clearTimeout(statusTimer);
    const track = getCurrent(), record = records.get(track?.id), items = current(), total = track ? articleItems(track).length : 0;
    const running = !!active && active.id === track?.id && !active.controller.signal.aborted || record?.status === 'running' && Date.now() - record.request?.startedAt < 190000;
    const status = document.getElementById('article-status');
    status.textContent = running ? `中文翻譯中 · ${items.length}/${total} 句` : items.length === total && total ? '' : items.length ? `中文 ${items.length}/${total} 句${record?.error ? ' · 未完成，可續傳' : ''}` : record?.error ? '翻譯未完成，可重試' : '尚無中文譯文';
    document.getElementById('article-tools').hidden = !getLibrary().settings.bilingual;
    const generate = document.getElementById('generate-article');
    generate.hidden = items.length === total && total > 0;
    generate.disabled = running || !total || !available(); generate.textContent = items.length ? '繼續翻譯' : 'AI 全文翻譯';
    document.getElementById('cancel-article').hidden = !active;
    changed(new Map(items.map(item => [item.id, item.text])));
    if (running) statusTimer = setTimeout(render, 1000);
  }
  async function refresh() {
    const token = ++epoch, id = getCurrent()?.id;
    const record = id ? await storage.read(`article:${id}`) : null;
    if (token !== epoch) return;
    if (id) records.set(id, record); render();
  }
  async function start(id) {
    if (active || !available()) { notify('翻譯或資料處理中，請稍後再試。'); return; }
    const track = getLibrary().tracks.find(track => track.id === id); if (!track) return;
    const job = { id, source: articleSource(track), controller: new AbortController() }; active = job; render();
    let key = '', context, finished = false;
    try {
      const record = await storage.read(GEMINI_KEY);
      if (!record) throw Error('請先在設定保存 Gemini API Key。');
      const source = articleSource(track), model = getLibrary().settings.geminiModel;
      articleBatches(track); // Validate before claiming or sending any text.
      const fingerprint = await articleFingerprint(source, model);
      if (job.controller.signal.aborted || !available()) return;
      context = { source, fingerprint, model, keyId: record.id, requestId: crypto.randomUUID() };
      const claim = await storage.updateArticle(id, { ...context, action: 'claim' });
      if (!claim.changed) throw Error('另一個視窗正在翻譯，或原文／Key 已變更。');
      records.set(id, claim.record); broadcast('article-changed'); render();
      key = await decryptApiKey(record);
      for (const batch of articleBatches(track, savedTranslations(claim.record, track))) {
        if (job.controller.signal.aborted || (await storage.read(GEMINI_KEY))?.id !== record.id) return;
        const result = await translateArticleBatch({ key, model, ...batch, signal: job.controller.signal });
        if (job.controller.signal.aborted) return;
        const saved = await storage.updateArticle(id, { ...context, action: 'batch', items: result.content });
        if (!saved.changed) throw Error('原文、Key 或音訊已變更，翻譯已停止。');
        records.set(id, saved.record); broadcast('article-changed'); render();
      }
      const saved = await storage.updateArticle(id, { ...context, action: 'complete' });
      if (!saved.changed) throw Error('翻譯狀態未保存，請重新開啟這一集。');
      records.set(id, saved.record); finished = true; broadcast('article-changed'); notify('全文中文翻譯已完成，可離線閱讀。');
    } catch (error) {
      if (!job.controller.signal.aborted) notify(error.message.replaceAll('導讀', '翻譯'), true);
    } finally {
      key = '';
      if (context && !finished) {
        const saved = await storage.updateArticle(id, { ...context, action: 'fail', error: '未完成，已保存的批次可離線閱讀；請手動續傳。' }).catch(() => null);
        if (saved?.changed) { records.set(id, saved.record); broadcast('article-changed'); }
      }
      if (active === job) active = null;
      render();
    }
  }
  document.getElementById('generate-article').onclick = () => { if (getCurrent()) void start(getCurrent().id); };
  document.getElementById('cancel-article').onclick = () => active?.controller.abort();
  function updateControls() {
    if (active) { const track = getLibrary().tracks.find(track => track.id === active.id); if (!track || articleSource(track) !== active.source) active.controller.abort(); }
    render();
  }
  return { start, refresh, render, current, updateControls, get busy() { return !!active; }, clear() { epoch++; active?.controller.abort(); records.clear(); render(); } };
}
