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
    return { start, end, text: plainText(item.text), ...(inferredEnd ? { inferredEnd: true } : {}), ...(item.timingUncertain === true ? { timingUncertain: true } : {}) };
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

export function transcriptCoverage(segments, duration) {
  const lastStart = segments.at(-1)?.start ?? 0;
  const timedEnd = Math.max(lastStart, 0, ...segments.filter(s => !s.inferredEnd).map(s => s.end));
  const trailingSeconds = Math.max(0, duration - timedEnd);
  return { lastStart, timedEnd, trailingSeconds, needsReview: segments.length > 0 && trailingSeconds > Math.max(30, duration * 0.03) };
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
