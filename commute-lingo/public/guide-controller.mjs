import * as storage from './storage.mjs?v=0.2.21';
import { GEMINI_KEY, encryptApiKey, decryptApiKey } from './key-vault.mjs?v=0.2.21';
import { generateGuide, verifyGeminiKey } from './gemini.mjs?v=0.2.21';
import { transcriptText, guideAvailable, guideFingerprint, validateGuide } from './guide.mjs?v=0.2.21';
import { normalizeWord, wordIdentity } from './vocabulary.mjs?v=0.2.21';

export function createGuideController({ getLibrary, getCurrent, getWords, saveWord, notify, openSettings, playQuote, broadcast, available = () => true }) {
  const $ = id => document.getElementById(id);
  const records = new Map(), queue = [];
  let active, keyBusy = false, hasKey = false, epoch = 0, keyEpoch = 0, selection, statusTimer;
  const notices = new Map();
  const element = (tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; };
  const action = (label, callback, className = 'text-button') => { const node = element('button', className, label); node.type = 'button'; node.onclick = () => Promise.resolve().then(callback).catch(error => notify(error.message, true)); return node; };
  const currentRecord = () => records.get(getCurrent()?.id);
  function keyControls() {
    $('gemini-key-status').textContent = hasKey ? 'Key 已在此裝置加密保存；開啟 App 即可使用。' : '尚未設定 Gemini API Key。';
    for (const id of ['save-gemini-key', 'verify-gemini-key', 'remove-gemini-key']) $(id).disabled = keyBusy || !available();
    $('remove-gemini-key').disabled ||= !hasKey;
    updateStatus();
    if (!active && !keyBusy && queue.length && available()) void pump();
  }
  function updateStatus() {
    clearTimeout(statusTimer);
    const track = getCurrent(), record = currentRecord();
    if (!track) return;
    const job = active?.id === track.id ? active : null;
    const running = !!job || record?.status === 'running' && Date.now() - record.request?.startedAt < 190000;
    const queued = queue.some(item => item.id === track.id);
    let content;
    try { if (record?.content) content = validateGuide(record.content, transcriptText(track)); } catch { /* Untrusted stored data. */ }
    const reason = !guideAvailable(track) ? '這一集尚無可用字幕。' : !hasKey ? '請先在設定保存 Gemini API Key。' : keyBusy ? 'Key 處理中。' : !available() ? '資料處理中，請稍後。' : '';
    const failed = notices.get(track.id) || (record?.status === 'failed' ? record.error : record?.status === 'running' && !running ? '上次導讀未完成，請手動重試。' : '');
    const phase = running ? 'running' : queued ? 'queued' : failed ? 'failed' : content ? 'ready' : 'missing';
    const elapsed = Math.max(0, Math.floor((Date.now() - (job?.startedAt || record?.request?.startedAt || Date.now())) / 1000));
    $('guide-status').textContent = running ? `產生中 · ${job?.message || '另一個視窗正在產生導讀…'}（${elapsed} 秒）` : queued ? '等待中' : failed ? `未完成 · ${failed}${content ? '（保留舊版）' : ''}` : content ? '已完成 · 可離線閱讀' : reason || '尚未產生';
    $('guide-help').textContent = reason; $('guide-help').hidden = !reason || !content;
    $('guide-panel').dataset.state = phase;
    $('guide-panel').setAttribute('aria-busy', String(running || queued));
    $('guide-state-label').textContent = running || queued ? '導讀…' : content && !failed ? '導讀 ✓' : failed ? '導讀 !' : '導讀';
    $('toggle-guide').setAttribute('aria-label', `導讀：${({ running: '產生中', queued: '等待中', failed: '未完成', ready: '已完成', missing: '尚未產生' })[phase]}`);
    $('generate-guide').disabled = running || queued || !!reason;
    $('generate-guide').textContent = running || queued ? '產生中…' : failed ? '重試導讀' : content ? '重新產生導讀' : '產生導讀';
    $('cancel-guide').hidden = !active && !queue.length;
    if (running) statusTimer = setTimeout(updateStatus, 1000);
  }
  async function refresh() {
    const token = ++epoch, id = getCurrent()?.id;
    const [key, record] = await Promise.all([storage.read(GEMINI_KEY), id ? storage.read(`guide:${id}`) : null]);
    if (token !== epoch) return;
    hasKey = !!key; if (id) records.set(id, record); keyControls(); render();
  }
  function render() {
    const track = getCurrent(), record = currentRecord();
    const root = $('guide-content'); root.replaceChildren(); selection = null; $('save-guide-selection').disabled = true; $('guide-selection-label').textContent = '選取導讀中的英文單字';
    if (!track) return;
    const source = transcriptText(track);
    let content;
    try { if (record?.content) content = validateGuide(record.content, source); } catch { /* Persisted/provider data is untrusted. */ }
    const running = active?.id === track.id || record?.status === 'running' && Date.now() - record.request?.startedAt < 190000;
    updateStatus();
    if (!content) {
      if (!hasKey) root.append(action('開啟 Gemini 設定', openSettings));
      return;
    }
    const settings = getLibrary().settings;
    void guideFingerprint(source, settings.geminiModel).then(fingerprint => {
      if (!running && !notices.has(track.id) && record.status === 'ready' && getCurrent()?.id === track.id && currentRecord() === record && record.fingerprint !== fingerprint) $('guide-status').textContent = '已完成 · 原文或模型已變更，可重新產生。';
    }).catch(() => {});
    const card = (heading, className) => { const section = element('section', `guide-card ${className}`); section.append(element('h3', '', heading)); root.append(section); return section; };
    card('01 · 課前導讀', 'guide-intro').append(element('p', '', content.intro));
    const route = card('02 · 聽力路線圖', 'guide-route'), list = element('ol');
    content.route.forEach(item => list.append(element('li', '', item))); route.append(list);
    const vocabulary = card('03 · 從線索猜字義', 'guide-vocabulary');
    for (const item of content.vocabulary) {
      const row = element('article', 'guide-word'), heading = element('div', 'guide-word-heading');
      heading.append(element('strong', '', item.term), element('small', '', item.pos));
      let word; try { word = normalizeWord(item.term); } catch { /* Phrase: individual words remain selectable. */ }
      if (word) {
        const exists = getWords().words.some(entry => wordIdentity(entry.word, entry.language) === wordIdentity(word, track.language));
        const save = action(exists ? '已收藏' : '＋收藏', async () => { await saveWord({ word, language: track.language, translation: item.meaning, translationSource: 'gemini', sourceTitle: getLibrary().tracks.find(entry => entry.id === track.id)?.title || track.title, note: `Gemini 導讀原句：${item.quote}` }); render(); }, 'guide-save-word');
        save.disabled = exists || !available(); save.setAttribute('aria-label', `${exists ? '已收藏' : '收藏單字'} ${word}`); heading.append(save);
      }
      const quote = element('blockquote', 'guide-source', item.quote); quote.dataset.quote = item.quote;
      const details = element('details'), summary = element('summary', '', '核對中文意思');
      details.append(summary, element('p', '', item.meaning));
      row.append(heading, quote, element('p', 'guide-clue', `猜字線索｜${item.clue}`), details); vocabulary.append(row);
    }
    if (content.sentence) {
      const section = card('04 · 難句跟讀', 'guide-sentence'), quote = element('blockquote', 'guide-source', content.sentence.quote); quote.dataset.quote = content.sentence.quote;
      section.append(quote, element('p', '', content.sentence.translation), element('p', 'guide-clue', content.sentence.explanation), action('播放這段原音', () => playQuote(content.sentence.quote)));
    }
  }
  async function pump() {
    if (active || keyBusy || !queue.length || !available()) return;
    const item = queue.shift(), track = getLibrary().tracks.find(track => track.id === item.id);
    if (!track || !guideAvailable(track)) { void pump(); return; }
    const controller = new AbortController(), job = { ...item, source: transcriptText(track), controller, message: '準備導讀…', startedAt: Date.now() }; active = job; render();
    let key = '', context;
    try {
      const settings = getLibrary().settings;
      const record = await storage.read(GEMINI_KEY);
      if (!record) { hasKey = false; throw Error('尚未保存 Gemini API Key，請先到個人設定加密保存。'); }
      const source = transcriptText(track), model = settings.geminiModel, fingerprint = await guideFingerprint(source, model);
      if (active !== job || controller.signal.aborted || !available()) return;
      context = { source, fingerprint, keyId: record.id, requestId: crypto.randomUUID(), model, automatic: item.automatic, force: item.force };
      const claim = await storage.updateGuide(track.id, { ...context, action: 'claim' });
      if (claim.record) records.set(track.id, claim.record);
      if (!claim.changed) {
        if (!claim.record) throw Error('無法啟動導讀，請重新開啟這一集後重試。');
        return;
      }
      job.claimed = true;
      broadcast('guide-changed'); render();
      key = await decryptApiKey(record);
      if (active !== job || controller.signal.aborted || (await storage.read(GEMINI_KEY))?.id !== record.id) return;
      const result = await generateGuide({ key, model, text: source, signal: controller.signal, progress: message => { job.message = message; updateStatus(); } });
      if (controller.signal.aborted) return;
      job.message = '內容已收到，正在驗證與保存…'; updateStatus();
      const saved = await storage.updateGuide(track.id, { ...context, action: 'complete', ...result });
      if (!saved.changed) throw Error('原文、Key 或音訊已變更，這次導讀未保存；請重新開啟後重試。');
      notices.delete(track.id); job.finished = true;
      if (saved.changed) { records.set(track.id, saved.record); broadcast('guide-changed'); notify(`「${getLibrary().tracks.find(entry => entry.id === track.id)?.title || track.title}」導讀已完成。`); }
    } catch (error) {
      if (!controller.signal.aborted) notices.set(track.id, error.message);
      if (context) {
        const saved = await storage.updateGuide(track.id, { ...context, action: 'fail', error: error.message }).catch(() => null);
        if (saved?.changed) { records.set(track.id, saved.record); broadcast('guide-changed'); }
        job.finished = true;
      }
      if (!controller.signal.aborted) notify(error.message, true);
    } finally {
      key = '';
      if (job.claimed && !job.finished) {
        const stopped = await storage.updateGuide(track.id, { ...context, action: 'fail', error: '導讀已停止，可手動重試。' }).catch(() => null);
        if (stopped?.changed) { records.set(track.id, stopped.record); broadcast('guide-changed'); }
      }
      if (active === job) active = null; keyControls(); render(); void pump();
    }
  }
  function start(id, { automatic = false, force = false } = {}) {
    // Legacy automatic calls must never upload a transcript, including old preferences.
    if (automatic) return;
    if (!available() || keyBusy) { notices.set(id, '正在儲存資料或處理 Key，請稍後再按一次。'); render(); return; }
    if (!guideAvailable(getLibrary().tracks.find(track => track.id === id))) { notices.set(id, '這一集尚無可用字幕。'); render(); return; }
    if (queue.some(item => item.id === id)) return;
    notices.delete(id);
    if (active?.id === id) {
      if (active.source === transcriptText(getLibrary().tracks.find(track => track.id === id))) return;
      active.controller.abort();
    }
    queue.push({ id, automatic: false, force }); render(); void pump();
  }
  function abort() { queue.length = 0; active?.controller.abort(); }
  async function manageKey(kind) {
    if (keyBusy || !available()) return;
    const token = keyEpoch;
    keyBusy = true; keyControls(); let key = $('gemini-key').value.trim(); $('gemini-key').value = '';
    try {
      const generation = await storage.dataGeneration();
      if (kind === 'save') {
        const record = await encryptApiKey(key); key = ''; abort();
        if (token !== keyEpoch) return;
        await storage.setGeminiKey(record, generation); broadcast('gemini-key-changed'); notify('Key 已加密保存。請在播放器開啟「導讀」，手動按「產生導讀」。');
      } else if (kind === 'remove') { abort(); await storage.setGeminiKey(null, generation); broadcast('gemini-key-changed'); notify('已移除此裝置的 Key。'); }
      else {
        if (!key) key = await decryptApiKey(await storage.read(GEMINI_KEY));
        if (token !== keyEpoch) return;
        const controller = new AbortController(); keyController = controller;
        $('gemini-key-status').textContent = '正在驗證 Key，這會送出一次簡短測試…';
        await verifyGeminiKey({ key, model: getLibrary().settings.geminiModel, signal: controller.signal }); notify('Gemini Key 連線驗證成功。');
      }
    } finally { key = ''; keyBusy = false; keyController = null; await refresh(); }
  }
  let keyController;
  for (const [id, kind] of [['save-gemini-key', 'save'], ['verify-gemini-key', 'verify'], ['remove-gemini-key', 'remove']]) $(id).onclick = () => manageKey(kind).catch(error => notify(error.message, true));
  $('generate-guide').onclick = () => { if (getCurrent()) start(getCurrent().id, { force: true }); };
  $('cancel-guide').onclick = () => { abort(); notify('已停止等待導讀；已送出的請求仍可能計入 Google 用量。'); };
  document.addEventListener('selectionchange', () => {
    if ($('guide-panel').hidden) return;
    const range = document.getSelection?.() || window.getSelection?.();
    if (!range || range.isCollapsed || !range.rangeCount) return;
    const parent = node => node?.nodeType === 1 ? node : node?.parentElement;
    const source = parent(range.anchorNode)?.closest('.guide-source');
    if (!source || !source.contains(range.focusNode)) return;
    try { const word = normalizeWord(range.toString()); selection = { word, quote: source.dataset.quote }; $('guide-selection-label').textContent = `已選取：${word}`; $('save-guide-selection').disabled = !available(); } catch { selection = null; $('save-guide-selection').disabled = true; }
  });
  $('save-guide-selection').onclick = () => {
    const track = getCurrent(), selected = selection;
    if (!track || !selected) return;
    const item = currentRecord()?.content?.vocabulary?.find(item => item.term.toLowerCase() === selected.word.toLowerCase());
    void saveWord({ word: selected.word, language: track.language, sourceTitle: track.title, translation: item?.meaning || '', translationSource: item ? 'gemini' : '', note: `Gemini 導讀原句：${selected.quote}` }).then(render).catch(error => notify(error.message, true));
  };
  return { refresh, render, start, abort, updateControls: keyControls, get busy() { return !!active || queue.length > 0 || keyBusy; }, get keyBusy() { return keyBusy; }, clear() { keyEpoch++; epoch++; abort(); keyController?.abort(); clearTimeout(statusTimer); notices.clear(); records.clear(); hasKey = false; $('gemini-key').value = ''; keyControls(); render(); } };
}
