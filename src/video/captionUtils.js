function toSrtTime(sec) {
    const ms = Math.max(0, Math.floor(Number(sec || 0) * 1000));
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    const mm = String(ms % 1000).padStart(3, '0');
    return `${h}:${m}:${s},${mm}`;
}

function chunkCaptions(words, maxChars = 24, maxDuration = 2.4) {
    const output = [];
    let cursor = null;
    for (const item of words || []) {
        const text = String(item.word || '').trim();
        if (!text) continue;
        const start = Number(item.start || 0);
        const end = Number(item.end || start);
        if (!cursor) {
            cursor = { startSec: start, endSec: end, parts: [text] };
            continue;
        }
        const draftText = [...cursor.parts, text].join('');
        const duration = end - cursor.startSec;
        if (draftText.length > maxChars || duration > maxDuration) {
            output.push({
                startSec: cursor.startSec,
                endSec: cursor.endSec,
                text: cursor.parts.join('').replace(/\s+/g, ' ').trim()
            });
            cursor = { startSec: start, endSec: end, parts: [text] };
            continue;
        }
        cursor.parts.push(text);
        cursor.endSec = end;
    }
    if (cursor && cursor.parts.length) {
        output.push({
            startSec: cursor.startSec,
            endSec: cursor.endSec,
            text: cursor.parts.join('').replace(/\s+/g, ' ').trim()
        });
    }
    return output.filter((x) => x.text);
}

function isCjkToken(text) {
    return /[\u3400-\u9FFF]/.test(String(text || ''));
}

function containsBoundary(text) {
    return /[，。！？；：,.!?;:、]/.test(String(text || ''));
}

// Returns true if text ends with a hard sentence-end punctuation (force break)
function endsWithHardBoundary(text) {
    return /[。！？…]$/.test(String(text || '').trim());
}

// Returns true if text ends with a soft pause punctuation (break only if chunk is long enough)
function endsWithSoftBoundary(text) {
    return /[，、；]$/.test(String(text || '').trim());
}

// Returns true if text ends with English sentence end (period/!? followed by no more text)
function endsWithEnglishSentence(text) {
    return /[.!?]$/.test(String(text || '').trim());
}

function normalizeTokenText(text) {
    const source = String(text || '').trim();
    if (!source) return '';
    return source
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/。+/g, '。')
        .replace(/，+/g, '，')
        .replace(/！+/g, '！')
        .replace(/？+/g, '？')
        .replace(/(\d)\s+(\d)/g, '$1$2')
        .replace(/[嗯呃啊哦哎]+(?=[，。！？\s]|$)/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseReplacementMap(raw) {
    const mapping = {};
    String(raw || '')
        .split(/[\n,，;；|]/g)
        .map((x) => x.trim())
        .filter(Boolean)
        .forEach((pair) => {
            const idx = pair.indexOf('=');
            if (idx <= 0) return;
            const from = pair.slice(0, idx).trim();
            const to = pair.slice(idx + 1).trim();
            if (!from || !to) return;
            mapping[from] = to;
        });
    return mapping;
}

function applyReplacementMap(text, replacementMap = {}) {
    const source = String(text || '');
    if (!source) return '';
    const entries = Object.entries(replacementMap).filter(([from, to]) => from && to);
    if (!entries.length) return source;
    const escapedKeys = entries
        .map(([from]) => from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .sort((a, b) => b.length - a.length);
    if (!escapedKeys.length) return source;
    const rule = new RegExp(escapedKeys.join('|'), 'g');
    return source.replace(rule, (hit) => replacementMap[hit] || hit);
}

function isHallucinatedText(text) {
    const s = String(text || '').trim();
    if (!s || s.length < 4) return false;
    for (let patLen = 1; patLen <= 4; patLen += 1) {
        const pat = s.slice(0, patLen);
        let count = 0;
        for (let i = 0; i <= s.length - patLen; i += patLen) {
            if (s.slice(i, i + patLen) === pat) count += 1;
            else break;
        }
        if (count >= 3 && (count * patLen) >= s.length * 0.6) return true;
    }
    return false;
}

function stripHallucinatedTail(rows) {
    if (rows.length < 6) return rows;
    let cutIdx = rows.length;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const txt = rows[i].text;
        if (isHallucinatedText(txt)) {
            cutIdx = i;
            continue;
        }
        const prevStart = i > 0 ? rows[i - 1].start : -1;
        const tooClose = Math.abs(rows[i].start - prevStart) < 0.05;
        if (tooClose && cutIdx < rows.length) {
            cutIdx = i;
            continue;
        }
        break;
    }
    if (rows.length - cutIdx >= 3) return rows.slice(0, cutIdx);
    let runLen = 1;
    for (let i = rows.length - 1; i > 0; i -= 1) {
        if (rows[i].text === rows[i - 1].text) {
            runLen += 1;
        } else {
            break;
        }
    }
    if (runLen >= 5) return rows.slice(0, rows.length - runLen);
    return rows;
}

function normalizeCaptionRows(payload = {}) {
    const fromWords = Array.isArray(payload.words) ? payload.words : [];
    const rows = fromWords.map((w) => ({
        start: Number(w.start ?? w.startSec ?? 0),
        end: Number(w.end ?? w.endSec ?? 0),
        text: String(w.word || w.text || '').trim()
    })).filter((x) => x.text);
    if (rows.length) return stripHallucinatedTail(rows);
    if (!Array.isArray(payload.segments)) return [];
    const segRows = payload.segments.map((seg) => ({
        start: Number(seg.start ?? 0),
        end: Number(seg.end ?? 0),
        text: String(seg.text || '').trim()
    })).filter((x) => x.text);
    return stripHallucinatedTail(segRows);
}

function mergeWordsToTerms(rows, options = {}) {
    const {
        cjkTermMaxChars = 4,
        cjkGapBreakSec = 0.36,
        latinGapBreakSec = 0.18
    } = options;
    if (!Array.isArray(rows) || !rows.length) return [];
    const terms = [];
    let cursor = null;
    const flush = () => {
        if (!cursor || !cursor.text) return;
        terms.push({
            start: cursor.start,
            end: Math.max(cursor.end, cursor.start + 0.12),
            text: cursor.text
        });
        cursor = null;
    };
    for (const row of rows) {
        const text = normalizeTokenText(String(row.text || '').replace(/\s+/g, ''));
        if (!text) continue;
        const start = Number(row.start || 0);
        const end = Number(row.end || start);
        const gap = cursor ? Math.max(0, start - cursor.end) : 0;
        const cjk = isCjkToken(text);
        if (!cursor) {
            cursor = { start, end, text };
            continue;
        }
        const nextLen = (cursor.text + text).length;
        const shouldBreak = (
            gap > (cjk ? cjkGapBreakSec : latinGapBreakSec)
            || containsBoundary(cursor.text)
            || containsBoundary(text)
            || (cjk && nextLen > cjkTermMaxChars)
        );
        if (shouldBreak) {
            flush();
            cursor = { start, end, text };
            continue;
        }
        cursor.text += cjk ? text : ` ${text}`;
        cursor.end = end;
    }
    flush();
    return terms.map((item) => ({
        ...item,
        text: String(item.text || '').replace(/\s+/g, ' ').trim()
    })).filter((item) => item.text);
}

function chunkTermsForDisplay(terms, options = {}) {
    const {
        chunkMaxChars = 14,
        chunkMaxDuration = 1.75,
        chunkGapBreakSec = 0.45,
        semanticBreak = true
    } = options;
    if (!Array.isArray(terms) || !terms.length) return [];
    const output = [];
    let cursor = null;
    for (const term of terms) {
        const text = normalizeTokenText(term.text);
        if (!text) continue;
        const start = Number(term.start || 0);
        const end = Number(term.end || start);
        if (!cursor) {
            cursor = { start, end, text };
            // If the very first term already ends with a hard boundary, flush it immediately
            if (semanticBreak && endsWithHardBoundary(text)) {
                output.push({ start: cursor.start, end: cursor.end, text: cursor.text });
                cursor = null;
            }
            continue;
        }
        const mergedText = `${cursor.text}${isCjkToken(text) ? '' : ' '}${text}`.trim();
        const duration = end - cursor.start;
        const shouldBreak = mergedText.length > chunkMaxChars || duration > chunkMaxDuration || (start - cursor.end) > chunkGapBreakSec;
        if (shouldBreak) {
            output.push({ start: cursor.start, end: cursor.end, text: cursor.text });
            cursor = { start, end, text };
            // Hard boundary on new cursor: flush immediately
            if (semanticBreak && endsWithHardBoundary(text)) {
                output.push({ start: cursor.start, end: cursor.end, text: cursor.text });
                cursor = null;
            }
            continue;
        }
        cursor.text = mergedText;
        cursor.end = end;
        // After merging, if the merged text now ends with a hard boundary, flush
        if (semanticBreak && endsWithHardBoundary(cursor.text)) {
            output.push({ start: cursor.start, end: cursor.end, text: cursor.text });
            cursor = null;
        }
    }
    if (cursor) output.push({ start: cursor.start, end: cursor.end, text: cursor.text });
    return output.filter((item) => item.text);
}

function buildSentenceCaptions(terms, options = {}) {
    const {
        sentenceMaxChars = 26,
        sentenceMaxDuration = 4.2,
        sentenceGapBreakSec = 0.7,
        semanticBreak = true
    } = options;
    if (!Array.isArray(terms) || !terms.length) return [];
    const output = [];
    let cursor = null;
    const flush = () => {
        if (!cursor || !cursor.text) return;
        output.push({ start: cursor.start, end: cursor.end, text: cursor.text.trim() });
        cursor = null;
    };
    for (const term of terms) {
        const text = normalizeTokenText(term.text);
        if (!text) continue;
        const start = Number(term.start || 0);
        const end = Number(term.end || start);
        if (!cursor) {
            cursor = { start, end, text };
            // If the first term itself ends with a hard boundary, flush immediately
            if (semanticBreak && endsWithHardBoundary(text)) flush();
            else if (!semanticBreak && containsBoundary(text)) flush();
            continue;
        }
        const separator = isCjkToken(text) ? '' : ' ';
        const merged = `${cursor.text}${separator}${text}`.trim();
        const duration = end - cursor.start;
        const gap = Math.max(0, start - cursor.end);
        const shouldBreak = merged.length > sentenceMaxChars || duration > sentenceMaxDuration || gap > sentenceGapBreakSec;
        if (shouldBreak) {
            flush();
            cursor = { start, end, text };
            if (semanticBreak && endsWithHardBoundary(text)) flush();
            else if (!semanticBreak && containsBoundary(text)) flush();
            continue;
        }
        cursor.text = merged;
        cursor.end = end;
        if (semanticBreak) {
            // Hard boundary (。！？…): always flush
            if (endsWithHardBoundary(text)) {
                flush();
            // Soft boundary (，、；): flush only if chunk has reached 60% of max chars
            } else if (endsWithSoftBoundary(text) && cursor && cursor.text.length >= sentenceMaxChars * 0.6) {
                flush();
            // English sentence end: flush (period/!/? at end of token)
            } else if (endsWithEnglishSentence(text) && !isCjkToken(text)) {
                flush();
            }
        } else if (containsBoundary(text)) {
            flush();
        }
    }
    flush();
    return output;
}

function normalizeCaptionOutput(items, replacementMap = {}) {
    return (items || []).map((item) => ({
        start: item.start,
        end: item.end,
        startSec: item.start,
        endSec: item.end,
        text: applyReplacementMap(normalizeTokenText(item.text), replacementMap)
    })).filter((item) => item.text);
}

function buildRobustCaptions(payload, fallbackText = '', options = {}) {
    const renderStyle = String(options.renderStyle || 'sentence').trim().toLowerCase();
    const replacementMap = parseReplacementMap(options.replacementMapRaw);
    const offsetSec = (Number(options.subtitleOffsetMs) || 0) / 1000;
    const rows = normalizeCaptionRows(payload).map((row) => {
        const rawStart = Number.isFinite(row.start) ? row.start : 0;
        const rawEnd = Number.isFinite(row.end) ? row.end : rawStart + 0.9;
        const start = Math.max(0, rawStart + offsetSec);
        const end = Math.max(start, rawEnd + offsetSec);
        const normalizedText = normalizeTokenText(row.text);
        const replacedText = applyReplacementMap(normalizedText, replacementMap);
        return {
            start,
            end: end > start ? end : start + 0.9,
            text: replacedText
        };
    }).filter((row) => row.text);
    if (rows.length) {
        const terms = mergeWordsToTerms(rows, options);
        const chunked = chunkTermsForDisplay(terms, options);
        const sentence = buildSentenceCaptions(chunked.length ? chunked : terms, options);
        if (renderStyle === 'word') {
            const wordRows = rows.map((item) => ({ start: item.start, end: item.end, text: item.text }));
            const refinedWords = normalizeCaptionOutput(wordRows, replacementMap);
            if (refinedWords.length) return refinedWords;
        }
        if (renderStyle === 'term') {
            const refinedTerms = normalizeCaptionOutput(terms, replacementMap);
            if (refinedTerms.length) return refinedTerms;
        }
        if (renderStyle === 'chunk') {
            const refinedChunks = normalizeCaptionOutput(chunked, replacementMap);
            if (refinedChunks.length) return refinedChunks;
        }
        const refinedSentence = normalizeCaptionOutput(sentence, replacementMap);
        if (refinedSentence.length) return refinedSentence;
    }
    const text = applyReplacementMap(normalizeTokenText(String(fallbackText || '').replace(/\s+/g, ' ')), replacementMap);
    if (!text) return [];
    return [{ start: 0, end: 6, startSec: 0, endSec: 6, text }];
}

// Post-process caption list to strip configurable filler words from each segment
function applyFillerRemoval(captions, fillerWords) {
    if (!Array.isArray(fillerWords) || !fillerWords.length) return captions;
    return captions
        .map((item) => ({ ...item, text: removeFillerWords(item.text, fillerWords) }))
        .filter((item) => item.text && item.text.length > 0);
}

function parseKeywordList(raw) {
    return String(raw || '')
        .split(/[\n,，、;；|]/g)
        .map((x) => x.trim())
        .filter(Boolean)
        .filter((x, i, arr) => arr.indexOf(x) === i);
}

// Remove configurable filler words from a single caption text (CJK: no word boundaries needed)
function removeFillerWords(text, fillerWords) {
    if (!Array.isArray(fillerWords) || !fillerWords.length) return text;
    let result = text;
    for (const word of fillerWords) {
        if (!word) continue;
        result = result.split(word).join('').replace(/\s{2,}/g, ' ').trim();
    }
    return result;
}

function toSrt(captions) {
    return (captions || []).map((item, idx) => {
        return `${idx + 1}\n${toSrtTime(item.startSec)} --> ${toSrtTime(item.endSec)}\n${item.text}\n`;
    }).join('\n');
}

module.exports = {
    chunkCaptions,
    toSrt,
    toSrtTime,
    buildRobustCaptions,
    parseKeywordList,
    removeFillerWords,
    applyFillerRemoval
};
