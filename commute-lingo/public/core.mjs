import { normalizeWordAnchors } from './reading.mjs?v=0.2.21';
export const SCHEMA = 'commute-lingo/1';
const encoder = new TextEncoder();
const plainText = value => String(value).replace(/<[^>]*>/g, '').trim();

export function timestamp(value) {
  const match = /^(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value);
  if (!match || +match[2] > 59 || +match[3] > 59) throw new Error('字幕時間格式不正確。');
  return +(match[1] || 0) * 3600 + +match[2] * 60 + +match[3] + +match[4] / 1000;
}

export function formatTime(seconds, milliseconds = false) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const parts = [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60];
  const value = parts.map(n => String(n).padStart(2, '0')).join(':');
  return milliseconds ? `${value}.${String(ms % 1000).padStart(3, '0')}` : value;
}

export function normalizeSegments(input, duration) {
  if (!Array.isArray(input) || !input.length || input.length > 20000) throw new Error('字幕沒有有效段落，或段落數過多。');
  let wordCount = 0;
  const segments = input.map((item, i) => {
    const times = item.timestamp ?? [item.start, item.end];
    const start = times[0];
    let end = times[1];
    const missingEnd = end === null;
    const inferredEnd = missingEnd || item.inferredEnd === true;
    if (missingEnd) end = input[i + 1]?.timestamp?.[0] ?? input[i + 1]?.start ?? duration;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error(`第 ${i + 1} 段的起訖時間無效；請先載入原音檔，再匯入字幕。`);
    }
    if (typeof item.text !== 'string' || !plainText(item.text)) throw new Error(`第 ${i + 1} 段缺少原文。`);
    const words = normalizeWordAnchors(item.words, { start, end, text: plainText(item.text) });
    wordCount += words?.length ?? 0;
    if (wordCount > 20000) throw new Error('逐字時間資料過多。');
    return { start, end, text: plainText(item.text), ...(words ? { words } : {}), ...(inferredEnd ? { inferredEnd: true } : {}), ...(item.timingUncertain === true ? { timingUncertain: true } : {}) };
  }).sort((a, b) => a.start - b.start);
  if (Number.isFinite(duration) && segments.some(s => s.end > duration + 2)) throw new Error('字幕超出音檔長度，請確認使用同一份音檔。');
  return segments;
}

// Model output can omit timestamps or reverse a boundary inside the 5-second
// overlap. Keep the words, use only bounded ranges, and disclose coarse timing.
// User-imported subtitles continue to use the strict normalizer above.
export function normalizeGeneratedSegments(input, duration) {
  if (!Array.isArray(input) || !input.length || input.length > 20000 || !Number.isFinite(duration) || duration <= 0) throw new Error('字幕模型沒有回傳有效的原文與音訊時間範圍。');
  const fail = index => { throw new Error(`字幕模型第 ${index + 1} 段的時間無法安全對齊，請切換轉錄模型後重試；原有收藏保持不變。`); };
  const warnings = [], work = input.map((item, index) => {
    const times = item?.timestamp ?? [item?.start, item?.end];
    if (!Array.isArray(times) || times.length !== 2 || !times.every(value => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0)) fail(index);
    if (typeof item?.text !== 'string') fail(index);
    return { start: times[0], end: times[1], text: item.text, index, ...(item.inferredEnd === true ? { inferredEnd: true } : {}) };
  }).filter(item => plainText(item.text));
  if (!work.length) throw new Error('字幕模型沒有回傳有效原文。');
  // Find following source anchors in linear time, including repeated starts.
  const nextKnown = [], nextGreater = [], stack = [];
  let following = null;
  for (let i = work.length - 1; i >= 0; i--) {
    nextKnown[i] = following;
    const start = work[i].start;
    if (start === null) continue;
    while (stack.length && stack.at(-1) <= start) stack.pop();
    nextGreater[i] = stack.at(-1) ?? duration;
    stack.push(start); following = start;
  }
  for (let i = 0; i < work.length; i++) {
    const item = work[i];
    if (item.start === null) {
      const previous = work[i - 1];
      const lower = previous && typeof previous.end === 'number' ? previous.end : 0;
      const upper = item.end ?? nextKnown[i] ?? duration;
      if (!(lower < upper && upper <= duration + 2)) fail(item.index);
      item.start = lower; item.end = upper; item.timingUncertain = true;
      if (input[item.index].timestamp?.[1] === null || input[item.index].end === null) item.inferredEnd = true;
      warnings.push({ type: 'missing-start', segment: item.index + 1, range: [lower, upper] });
    } else if (item.end === null) {
      item.end = nextGreater[i];
      item.inferredEnd = true;
      if (nextKnown[i] !== null && nextKnown[i] <= item.start) {
        item.timingUncertain = true;
        warnings.push({ type: 'missing-end', segment: item.index + 1, range: [item.start, item.end] });
      }
    }
  }
  const valid = item => item && !item.removed && item.start < item.end && item.end <= duration + 2;
  for (let i = 0; i < work.length; i++) {
    const item = work[i];
    if (item.removed || valid(item)) continue;
    // Do not fabricate a duration for equal/reversed model timestamps. Only
    // merge into an adjacent valid cue already covering both boundary values.
    if (item.start - item.end > 5.02 || item.start < item.end) fail(item.index);
    const covers = candidate => valid(candidate) && !candidate.timingUncertain && !candidate.inferredEnd && item.end >= candidate.start && item.start <= candidate.end;
    const next = work[i + 1], previous = work[i - 1];
    let anchor;
    if (covers(next)) { anchor = next; anchor.text = `${item.text}\n${anchor.text}`; }
    else if (covers(previous)) { anchor = previous; anchor.text += `\n${item.text}`; }
    else fail(item.index);
    anchor.timingUncertain = true; item.removed = true;
    warnings.push({ type: 'overlap-boundary', segment: item.index + 1, range: [anchor.start, anchor.end] });
  }
  const segments = normalizeSegments(work.filter(item => !item.removed), duration);
  return { segments, warnings };
}

export function parseTranscript(text, { duration, audioHash } = {}) {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (source.startsWith('{') || source.startsWith('[')) {
    let doc;
    try { doc = JSON.parse(source); } catch { throw new Error('JSON 字幕格式不正確。'); }
    if (doc.schema && doc.schema !== SCHEMA) throw new Error('不支援此字幕版本。');
    if (doc.audio?.sha256 && doc.audio.sha256 !== audioHash) throw new Error('字幕對應另一份音檔，請改用匯出時搭配的音檔。');
    const segments = normalizeSegments(Array.isArray(doc) ? doc : doc.segments ?? doc.chunks, duration);
    return { segments, language: doc.language, verifiedAudio: Boolean(doc.audio?.sha256), translations: validTranslations(doc.translations), metrics: doc.metrics };
  }
  const cues = [];
  for (const block of source.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(lines[0])) continue;
    const index = lines.findIndex(line => line.includes('-->'));
    if (index < 0) continue;
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[index]);
    if (!match) throw new Error('字幕時間行不正確。');
    cues.push({ start: timestamp(match[1]), end: timestamp(match[2]), text: lines.slice(index + 1).join('\n') });
  }
  return { segments: normalizeSegments(cues, duration), verifiedAudio: false, translations: [] };
}

export function validTranslations(input) {
  if (!Array.isArray(input)) return [];
  return input.filter(t => t && ['source', 'target', 'text', 'translation'].every(k => typeof t[k] === 'string') && t.text.length <= 50000 && t.translation.length <= 100000).slice(0, 1000);
}

export function findActive(segments, time) {
  // Overlapping cues are allowed. Prefer the last cue starting before playback.
  let low = 0, high = segments.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (segments[mid].start <= time) low = mid + 1; else high = mid;
  }
  for (let i = low - 1; i >= 0; i--) if (time < segments[i].end) return i;
  return -1;
}

function sentenceEnd(text) {
  if (!/[.!?。！？]["'”’»」』）)\]]*$/u.test(text)) return false;
  return !/(?:\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs)|\b[A-Z]|\b(?:e\.g|i\.e))\.$/iu.test(text);
}

export function groupSentences(segments, language = 'en', includeWords = false) {
  const groups = [];
  let pending;
  const separator = /^(ja|zh)/.test(language) ? '' : ' ';
  for (const segment of segments) {
    if (!pending) pending = { start: segment.start, end: segment.end, text: segment.text, ...(segment.timingUncertain ? { timingUncertain: true } : {}), ...(segment.inferredEnd ? { inferredEnd: true } : {}) };
    else {
      if (segment.end >= pending.end) {
        pending.end = segment.end;
        if (segment.inferredEnd) pending.inferredEnd = true; else delete pending.inferredEnd;
      }
      pending.text += separator + segment.text;
      if (segment.timingUncertain) pending.timingUncertain = true;
    }
    if (includeWords) (pending.words ??= []).push(segment);
    if (sentenceEnd(pending.text)) { groups.push({ ...pending, incomplete: false }); pending = undefined; }
  }
  if (pending) groups.push({ ...pending, incomplete: true });
  return groups;
}

// DTW may anchor several adjacent words to the same instant. Sentence playback
// needs the first/last word's range, not a fabricated duration for every word.
export function normalizeWordSentences(input, duration, language = 'en') {
  if (!Array.isArray(input) || !input.length || input.length > 20000 || !Number.isFinite(duration) || duration <= 0) throw new Error('模型未提供有效的逐字對齊資料。');
  let previousStart = -Infinity;
  const words = input.map((item, index) => {
    const times = item?.timestamp;
    if (!Array.isArray(times) || times.length !== 2 || !times.every(time => typeof time === 'number' && Number.isFinite(time) && time >= 0 && time <= duration + 2)
      || times[1] < times[0] || times[0] < previousStart || typeof item.text !== 'string' || !plainText(item.text)) throw new Error(`模型第 ${index + 1} 個字詞無法對齊，請切換模型後重試。`);
    previousStart = times[0];
    return { start: times[0], end: times[1], text: plainText(item.text) };
  });
  const sentences = [];
  let duplicateSentences = 0;
  for (const sentence of groupSentences(words, language, true)) {
    const previous = sentences.at(-1);
    // Sometimes DTW splits one utterance into two identical sentences: one
    // copy anchors the prefix and the other anchors the suffix. Collapse only
    // complementary copies at the same boundary; genuine timed repetitions
    // keep both copies. No words are assigned a synthetic duration.
    const complementary = previous && previous.text === sentence.text && Math.abs(previous.end - sentence.start) <= 0.04 && previous.words.length === sentence.words.length
      && previous.words.every((word, i) => word.text === sentence.words[i].text && (word.end > word.start) !== (sentence.words[i].end > sentence.words[i].start));
    const anchors = complementary ? previous.words.map((word, i) => word.end > word.start ? word : sentence.words[i]) : null;
    if (anchors && anchors.every((word, i) => !i || word.start >= anchors[i - 1].start)) {
      sentences[sentences.length - 1] = { ...sentence, start: anchors[0].start, end: Math.max(...anchors.map(word => word.end)), words: anchors };
      duplicateSentences++;
    } else sentences.push(sentence);
  }
  return { segments: normalizeSegments(sentences, duration), warnings: [], duplicateSentences };
}

// Generated subtitles are optional output of a valid audio import. Keep strict
// subtitle-file validation above, but retain bounded model text when timing or
// a worker fails. Coarse ranges describe real audio windows, not invented word
// timing. No placeholder sentence is inserted when recognition produced none.
export function availableTranscript(output, duration, language = 'en') {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('音訊長度無效。');
  output = output && typeof output === 'object' ? output : {};
  const segments = [], warnings = [];
  let duplicateSentences = 0, characters = 0;
  const warn = (type, range) => { if (warnings.length < 400) warnings.push({ type, ...(range ? { range } : {}) }); };
  const safeChunks = chunks => Array.isArray(chunks) && chunks.length <= 20000 && chunks.every(item => typeof item?.text === 'string' && item.text.length <= 20000)
    && chunks.reduce((sum, item) => sum + item.text.length, 0) <= 500000;
  const add = items => {
    for (const item of items) {
      if (segments.length >= 20000 || characters + item.text.length > 500000) { warn('output-limit'); break; }
      segments.push(item); characters += item.text.length;
    }
  };
  const coarse = chunks => {
    if (!Array.isArray(chunks)) return;
    for (const item of chunks.slice(0, 20000)) {
      if (typeof item?.text !== 'string') continue;
      const limit = Math.min(20000, 500000 - characters);
      if (item.text.length > limit) warn('output-limit');
      const text = plainText(item.text.slice(0, limit));
      if (!text) continue;
      let start = item.start, end = item.end;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start >= duration || end > duration + 0.1) { start = 0; end = duration; }
      add([{ start, end: Math.min(end, duration), text, timingUncertain: true }]);
    }
  };
  const normalize = (chunks, mode) => {
    if (!safeChunks(chunks)) throw new Error('Invalid generated text');
    const result = mode === 'word' ? normalizeWordSentences(chunks, duration, language) : normalizeGeneratedSegments(chunks, duration);
    duplicateSentences += result.duplicateSentences || 0;
    for (const warning of result.warnings || []) warn(warning.type, warning.range);
    return result.segments;
  };
  const rescueWords = (chunks, fallback) => {
    if (!safeChunks(chunks)) return false;
    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      try { add(normalize(pending, 'word')); }
      catch {
        const anchors = pending.flatMap(item => Array.isArray(item.timestamp) ? item.timestamp.filter(time => Number.isFinite(time) && time >= 0 && time <= duration) : []);
        const windows = (Array.isArray(fallback) ? fallback : []).slice(0, 400).filter(item => Number.isFinite(item?.start) && Number.isFinite(item?.end) && item.start >= 0 && item.end > item.start && item.end <= duration + .1);
        const nearby = windows.filter(item => anchors.some(time => time >= item.start && time <= item.end));
        const candidates = nearby.length ? nearby : windows;
        const start = candidates.length ? Math.min(...candidates.map(item => item.start)) : 0;
        const end = candidates.length ? Math.max(...candidates.map(item => item.end)) : duration;
        coarse([{ start, end, text: pending.map(item => plainText(item.text)).join(' ') }]);
        warn('coarse-sentence', [start, Math.min(end, duration)]);
      }
      pending = [];
    };
    for (const item of chunks) { pending.push(item); if (sentenceEnd(item.text.trim())) flush(); }
    flush(); return true;
  };
  let precise = false;
  if (output.timestampMode !== 'mixed') {
    try { add(normalize(output.chunks, output.timestampMode === 'word' ? 'word' : 'segment')); precise = true; }
    catch { warn('normalization-fallback'); }
  }
  if (!precise) {
    if (Array.isArray(output.regions) && output.regions.length <= 400) {
      for (const region of output.regions) {
        if (segments.length >= 20000 || characters >= 500000) { warn('output-limit'); break; }
        try {
          if (!['word', 'segment'].includes(region?.mode)) throw new Error('Coarse region');
          add(normalize(region.chunks, region.mode));
        } catch {
          if (region?.mode !== 'word' || !rescueWords(region.chunks, region.fallbackChunks)) coarse(region?.fallbackChunks);
          warn('coarse-window');
        }
      }
    }
    else if (output.timestampMode === 'word') rescueWords(output.chunks, output.fallbackChunks);
    if (!segments.length) coarse(output.fallbackChunks?.length ? output.fallbackChunks : output.chunks);
  }
  for (const range of (Array.isArray(output.boundaries) ? output.boundaries : []).slice(0, 400)) {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] < 0 || range[1] <= range[0] || range[1] > duration + .1) continue;
    for (const segment of segments) if (segment.start < range[1] && segment.end > range[0]) segment.timingUncertain = true;
    warn('overlap-boundary', range);
  }
  for (const range of (Array.isArray(output.missingRanges) ? output.missingRanges : []).slice(0, 400)) {
    if (Array.isArray(range) && range.length === 2 && range.every(Number.isFinite) && range[0] >= 0 && range[1] > range[0] && range[1] <= duration + .1) warn('missing-words', range);
  }
  if (!Number.isFinite(output.processedSeconds) || Math.abs(output.processedSeconds - duration) > .1 || output.incomplete) warn('partial-inference');
  if (Array.isArray(output.warningCodes) && output.warningCodes.length) warn('model-warning');
  if (!warnings.length && segments.some(segment => segment.timingUncertain)) warn('coarse-timing');
  if (!segments.length) warn('no-transcript');
  const transcriptStatus = !segments.length ? 'audio-only' : warnings.length ? 'partial' : 'complete';
  return { segments: segments.sort((a, b) => a.start - b.start), warnings, duplicateSentences, transcriptStatus,
    alignment: transcriptStatus === 'complete' ? output.timestampMode === 'word' ? 'word-v1' : 'segment-v1' : 'mixed-v1' };
}

export function transcriptCoverage(segments, duration) {
  const lastStart = segments.at(-1)?.start ?? 0;
  const timedEnd = Math.max(lastStart, 0, ...segments.filter(s => !s.inferredEnd).map(s => s.end));
  const trailingSeconds = Math.max(0, duration - timedEnd);
  return { lastStart, timedEnd, trailingSeconds, needsReview: !segments.length || trailingSeconds > Math.max(30, duration * 0.03) };
}

// Several sentences can share one source cue. Keep that original timing, but
// let a long press translate one sentence without inventing word timestamps.
export function sentenceTexts(text, language = 'en') {
  if (globalThis.Intl?.Segmenter) return [...new Intl.Segmenter(language, { granularity: 'sentence' }).segment(text)].map(item => item.segment.trim()).filter(Boolean);
  return text.match(/[^.!?。！？]+(?:[.!?。！？]+["'”’」』)]*|$)/gu)?.map(part => part.trim()).filter(Boolean) || [text];
}

export function checkDecodedAudio(sampleCount, sampleRate, mediaDuration) {
  if (!Number.isFinite(sampleCount) || sampleCount <= 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('解碼後的音訊是空白或格式不正確。');
  const seconds = sampleCount / sampleRate;
  if (!Number.isFinite(mediaDuration) || mediaDuration <= 0 || Math.abs(seconds - mediaDuration) > Math.max(2, mediaDuration * 0.01)) {
    throw new Error(`音訊解碼長度 ${formatTime(seconds)} 與播放器 ${formatTime(mediaDuration || 0)} 不符，已停止，避免只轉錄前段。請重新取得來源，或改用其他單集。`);
  }
  return seconds;
}

export function toSRT(segments) {
  return segments.map((s, i) => `${i + 1}\n${formatTime(s.start, true).replace('.', ',')} --> ${formatTime(s.end, true).replace('.', ',')}\n${s.text}\n`).join('\n');
}

export function splitForTranslation(text, maximum = 500) {
  let remaining = text.trim();
  if (!remaining) throw new Error('請先選擇原文。');
  if (maximum < 4 || maximum > 500) throw new Error('翻譯單次大小必須介於 4 至 500 bytes。');
  const chunks = [];
  while (remaining) {
    let bytes = 0, end = 0, boundary = 0, sentenceBoundary = 0;
    for (const char of remaining) {
      const size = encoder.encode(char).length;
      if (bytes + size > maximum) break;
      bytes += size; end += char.length;
      if (/[\s.!?。！？]/u.test(char)) boundary = end;
      if (sentenceEnd(remaining.slice(0, end).trimEnd())) sentenceBoundary = end;
    }
    if (end < remaining.length && sentenceBoundary > 0) end = sentenceBoundary;
    else if (end < remaining.length && boundary > 0) end = boundary;
    const chunk = remaining.slice(0, end).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(end).trimStart();
  }
  return chunks;
}

export function appleLookupURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('請貼上完整 Apple Podcast 單集連結。'); }
  const show = /\/id(\d+)\/?$/.exec(url.pathname)?.[1];
  const episode = url.searchParams.get('i');
  if (url.protocol !== 'https:' || url.hostname !== 'podcasts.apple.com' || url.username || url.password || !show || !/^\d+$/.test(episode ?? '')) {
    throw new Error('請使用含單集編號的 podcasts.apple.com HTTPS 連結。');
  }
  return { url: `https://itunes.apple.com/lookup?id=${show}&entity=podcastEpisode&limit=200`, episode };
}
