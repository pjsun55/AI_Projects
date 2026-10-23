// Sentence cards retain the original text and model anchors verbatim.
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
export function readingCues(cues) {
  // sentencesFor already groups source fragments by sentence-ending punctuation.
  // Width, word count and elapsed time must not split that sentence into cards.
  return cues.map(cue => {
    let words;
    try { words = !cue.timingUncertain && !cue.inferredEnd ? normalizeWordAnchors(cue.words, cue) : undefined; } catch { words = undefined; }
    return { ...cue, words };
  });
}
export function activeWord(words, time) {
  if (!Array.isArray(words)) return -1;
  // Reject zero duration, overlapping or implausibly stretched anchors. Leave
  // the complete sentence visible instead of fabricating an interpolated cursor.
  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i];
    if (word.start > time) continue;
    if (time < word.end && word.end > word.start && word.end - word.start <= 2.5 && !/\s/u.test(word.text) && (!i || words[i - 1].end <= word.start) && (i === words.length - 1 || word.end <= words[i + 1].start)) return i;
  }
  return -1;
}
