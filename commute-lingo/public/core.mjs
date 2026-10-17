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
    return { start, end, text: plainText(item.text), ...(inferredEnd ? { inferredEnd: true } : {}) };
  }).sort((a, b) => a.start - b.start);
  if (Number.isFinite(duration) && segments.some(s => s.end > duration + 2)) throw new Error('字幕超出音檔長度，請確認使用同一份音檔。');
  return segments;
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

export function groupSentences(segments, language = 'en') {
  const groups = [];
  let pending;
  const separator = /^(ja|zh)/.test(language) ? '' : ' ';
  for (const segment of segments) {
    if (!pending) pending = { start: segment.start, end: segment.end, text: segment.text };
    else { pending.end = Math.max(pending.end, segment.end); pending.text += separator + segment.text; }
    if (sentenceEnd(pending.text)) { groups.push({ ...pending, incomplete: false }); pending = undefined; }
  }
  if (pending) groups.push({ ...pending, incomplete: true });
  return groups;
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
