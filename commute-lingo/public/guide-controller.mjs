import * as storage from './storage.mjs?v=0.2.18';
import { GEMINI_KEY, encryptApiKey, decryptApiKey } from './key-vault.mjs?v=0.2.18';
import { generateGuide, verifyGeminiKey } from './gemini.mjs?v=0.2.18';
import { transcriptText, guideAvailable, guideFingerprint, validateGuide } from './guide.mjs?v=0.2.18';
import { normalizeWord, wordIdentity } from './vocabulary.mjs?v=0.2.18';

export function createGuideController({ getLibrary, getCurrent, getWords, saveWord, notify, openSettings, playQuote, broadcast, available = () => true }) {
  const $ = id => document.getElementById(id);
  const records = new Map(), queue = [];
  let active, keyBusy = false, hasKey = false, epoch = 0, keyEpoch = 0, selection;
  const element = (tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; };
  const action = (label, callback, className = 'text-button') => { const node = element('button', className, label); node.type = 'button'; node.onclick = () => Promise.resolve().then(callback).catch(error => notify(error.message, true)); return node; };
  const currentRecord = () => records.get(getCurrent()?.id);
  function keyControls() {
    $('gemini-key-status').textContent = hasKey ? 'Key 已在此裝置加密保存；開啟 App 即可使用。' : '尚未設定 Gemini API Key。';
    for (const id of ['save-gemini-key', 'verify-gemini-key', 'remove-gemini-key']) $(id).disabled = keyBusy || !available();
    $('remove-gemini-key').disabled ||= !hasKey;
    const track = getCurrent(), record = currentRecord();
    const running = active?.id === track?.id && !!active || record?.status === 'running' && Date.now() - record.request?.startedAt < 190000;
    $('generate-guide').disabled = running || !available() || !guideAvailable(track) || !hasKey;
    $('cancel-guide').hidden = !active;
    if (!active && !keyBusy && queue.length && available()) void pump();
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
    $('guide-status').textContent = running ? active?.message || '導讀解析中…' : record?.status === 'failed' ? record.error || '導讀待重試。' : content ? '導讀已保存在此裝置，可離線閱讀。' : '尚未產生導讀。';
    $('generate-guide').disabled = running || !available() || !guideAvailable(track) || !hasKey;
    $('generate-guide').textContent = content ? '重新產生導讀' : record?.status === 'failed' ? '重試導讀' : '產生導讀';
    if (!content) {
      const message = !guideAvailable(track) ? '請先完成這一集的字幕，再產生導讀。' : !hasKey ? '到個人設定輸入自己的 Gemini Key，即可產生導讀。' : running ? '可以繼續播放；導讀完成後會保存。' : '產生後可隨時閱讀，不會因重播而再次呼叫 API。';
      root.append(element('p', 'guide-empty', message));
      if (!hasKey) root.append(action('開啟 Gemini 設定', openSettings));
      return;
    }
    const settings = getLibrary().settings;
    void guideFingerprint(source, settings.geminiModel).then(fingerprint => {
      if (!running && getCurrent()?.id === track.id && currentRecord() === record && record.fingerprint !== fingerprint) $('guide-status').textContent = '原文或導讀設定已變更；目前顯示已保存版本，可重新產生。';
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
    root.append(element('p', 'guide-footnote', 'Gemini 導讀依原文整理；不確定時請對照原文。收藏只保存選定單字，不會再次呼叫 Gemini。'));
  }
  async function pump() {
    if (active || keyBusy || !queue.length || !available()) return;
    const item = queue.shift(), track = getLibrary().tracks.find(track => track.id === item.id);
    if (!track || !guideAvailable(track)) { void pump(); return; }
    const controller = new AbortController(), job = { ...item, source: transcriptText(track), controller, message: '準備導讀…' }; active = job; render();
    let key = '', context;
    try {
      const settings = getLibrary().settings;
      if (item.automatic && !settings.autoGuide) return;
      const record = await storage.read(GEMINI_KEY); if (!record) return;
      const source = transcriptText(track), model = settings.geminiModel, fingerprint = await guideFingerprint(source, model);
      if (active !== job || controller.signal.aborted || !available()) return;
      context = { source, fingerprint, keyId: record.id, requestId: crypto.randomUUID(), model, automatic: item.automatic, force: item.force };
      const claim = await storage.updateGuide(track.id, { ...context, action: 'claim' });
      if (claim.record) records.set(track.id, claim.record);
      if (!claim.changed) return;
      job.claimed = true;
      broadcast('guide-changed'); render();
      key = await decryptApiKey(record);
      if (active !== job || controller.signal.aborted || (await storage.read(GEMINI_KEY))?.id !== record.id) return;
      const result = await generateGuide({ key, model, text: source, signal: controller.signal, progress: message => { job.message = message; if (getCurrent()?.id === track.id) $('guide-status').textContent = message; } });
      if (controller.signal.aborted) return;
      const saved = await storage.updateGuide(track.id, { ...context, action: 'complete', ...result });
      job.finished = true;
      if (saved.changed) { records.set(track.id, saved.record); broadcast('guide-changed'); notify(`「${getLibrary().tracks.find(entry => entry.id === track.id)?.title || track.title}」導讀已完成。`); }
    } catch (error) {
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
    if (!available() || queue.some(item => item.id === id)) return;
    if (automatic && !getLibrary().settings.autoGuide) return;
    if (active?.id === id) {
      if (active.source === transcriptText(getLibrary().tracks.find(track => track.id === id))) return;
      active.controller.abort();
    }
    queue.push({ id, automatic, force }); void pump();
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
        await storage.setGeminiKey(record, generation); broadcast('gemini-key-changed'); notify('Key 已加密保存，之後的新字幕可自動產生導讀。');
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
  return { refresh, render, start, abort, updateControls: keyControls, get busy() { return !!active || queue.length > 0 || keyBusy; }, get keyBusy() { return keyBusy; }, clear() { keyEpoch++; epoch++; abort(); keyController?.abort(); records.clear(); hasKey = false; $('gemini-key').value = ''; keyControls(); render(); } };
}
