// Model anchors are retained verbatim. Display limits never invent word times.
const clean = value => value.replace(/<[^>]*>/g, '').trim();
const compact = value => value.replace(/\s+/gu, '');
export function normalizeWordAnchors(input, cue) {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || !input.length || input.length > 20000) throw new Error('逐字時間資料過多或格式不正確。');
  let previous = cue.start, characters = 0;
  const words = input.map(word => {
    if (!word || typeof word.text !== 'string' || !word.text.trim() || word.text.length > 500 || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < cue.start || word.start < previous || word.end < word.start || word.end > cue.end) throw new Error('逐字時間超出原句或順序不正確。');
    previous = word.start; characters += word.text.length;
    if (characters > 500000) throw new Error('逐字文字過多。');
    return { start: word.start, end: word.end, text: clean(word.text) };
  });
  if (words.some(word => !word.text) || compact(words.map(word => word.text).join('')) !== compact(cue.text)) throw new Error('逐字文字與原句不符。');
  return words;
}
export function readingPages(text, maximum = 40, count = 6) {
  const pieces = text.match(/\S+\s*|\s+/gu) || [text], pages = []; let pending = '', units = 0;
  for (const piece of pieces) {
    // Very long unspaced text (including CJK) remains bounded without guessing times.
    const parts = Array.from(piece).length > maximum ? piece.match(new RegExp('[\\s\\S]{1,' + Math.floor(maximum / 2) + '}', 'gu')) : [piece];
    for (const part of parts) {
      if (pending && (units >= count || Array.from(pending + part).length > maximum)) { pages.push(pending); pending = ''; units = 0; }
      pending += part; units++;
    }
  }
  if (pending) pages.push(pending);
  return pages;
}
export function readingCues(cues, language = 'en') {
  const result = [], separator = /^(ja|zh)/u.test(language) ? '' : ' ';
  for (const cue of cues) {
    let words;
    try { words = !cue.timingUncertain && !cue.inferredEnd ? normalizeWordAnchors(cue.words, cue) : undefined; } catch { words = undefined; }
    if (!words) { result.push({ ...cue, words: undefined, pages: cue.text.length > 160 || cue.text.trim().split(/\s+/u).length > 24 ? readingPages(cue.text) : [cue.text] }); continue; }
    const groups = []; let pending = [], length = 0, groupEnd = 0;
    const flush = () => { if (pending.length) { groups.push(pending); pending = []; length = 0; groupEnd = 0; } };
    for (const word of words) {
      const last = pending.at(-1), start = pending[0]?.start;
      if (last && groupEnd > start && word.start >= groupEnd && (pending.length >= 6 || length + word.text.length + 1 > (/^(ja|zh)/u.test(language) ? 24 : 40) || word.end - start > 4.5 && word.end - word.start <= 2.5 && last.end - last.start <= 2.5)) flush();
      pending.push(word); length += word.text.length + separator.length; groupEnd = Math.max(groupEnd, word.end);
    }
    flush();
    if (groups.length > 1 && groups.at(-1).every(word => word.end === word.start)) groups[groups.length - 2].push(...groups.pop());
    for (const group of groups) {
      const start = group[0].start, end = Math.max(...group.map(word => word.end)), text = group.map(word => word.text).join(separator);
      if (!(end > start)) { result.push({ ...cue, words: undefined, pages: readingPages(cue.text) }); break; }
      result.push({ ...cue, start, end, text, words: group, sourceText: cue.text, sourceStart: cue.start, sourceEnd: cue.end, pages: readingPages(text) });
    }
  }
  return result;
}
export function activeWord(words, time) {
  if (!Array.isArray(words)) return -1;
  // Reject zero duration, overlapping or implausibly stretched anchors. Leave
  // the short phrase visible instead of fabricating an interpolated cursor.
  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i];
    if (word.start > time) continue;
    if (time < word.end && word.end > word.start && word.end - word.start <= 2.5 && !/\s/u.test(word.text) && (!i || words[i - 1].end <= word.start) && (i === words.length - 1 || word.end <= words[i + 1].start)) return i;
  }
  return -1;
}
