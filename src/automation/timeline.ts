import type { Rational, TickRange } from './contracts.js';
import { requireCondition } from './errors.js';

export const TICKS_PER_SECOND = 254_016_000_000n;
export interface Word { word: string; range: TickRange; confidence?: number }
export interface CutSegment { segmentKey: string; sourceAssetId: string; sourceRange: TickRange; timelineRange: TickRange; speedNumerator: number; speedDenominator: number; reverse: boolean }
export interface Cue { cueKey: string; text: string; range: TickRange }
export function frameTicks(frame: string | bigint, rate: Rational): string {
  const numerator = BigInt(frame) * TICKS_PER_SECOND * BigInt(rate.den);
  requireCondition(rate.num > 0 && rate.den > 0 && Number.isInteger(rate.num) && Number.isInteger(rate.den), 'INVALID_FRAME_RATE', 'A positive rational frame rate is required.');
  requireCondition(numerator % BigInt(rate.num) === 0n, 'INEXACT_FRAME_TICKS', 'This frame rate cannot be represented exactly in Adobe ticks.');
  return String(numerator / BigInt(rate.num));
}
export function secondsTicks(seconds: number): string {
  requireCondition(Number.isFinite(seconds), 'INVALID_TIME', 'Time must be finite.');
  // Quantize decimal seconds to nanoseconds before converting, never through a tick Number.
  const nanoseconds = BigInt(Math.round(seconds * 1e9)); return String(nanoseconds * TICKS_PER_SECOND / 1_000_000_000n);
}
export const range = (start: bigint | string, end: bigint | string): TickRange => ({ start: { ticks: String(start) }, end: { ticks: String(end) } });
export function intersect(a: TickRange, b: TickRange): TickRange | null {
  const start = BigInt(a.start.ticks) > BigInt(b.start.ticks) ? BigInt(a.start.ticks) : BigInt(b.start.ticks);
  const end = BigInt(a.end.ticks) < BigInt(b.end.ticks) ? BigInt(a.end.ticks) : BigInt(b.end.ticks);
  return start < end ? range(start, end) : null;
}
export function buildInterviewCutMap(input: {
  sourceAssetId: string; durationTicks: string; words: Word[]; silence: TickRange[];
  enabled: boolean; minimumSilenceMs: number; keepHeadMs: number; keepTailMs: number;
  keepRanges?: TickRange[];
}): CutSegment[] {
  const duration = BigInt(input.durationTicks); requireCondition(duration > 0n, 'INVALID_MEDIA_DURATION', 'Source duration must be observed and positive.');
  const whole = range(0n, duration);
  let kept: TickRange[];
  if (input.keepRanges) kept = input.keepRanges.map(item => {
    requireCondition(BigInt(item.start.ticks) >= 0n && BigInt(item.end.ticks) <= duration && BigInt(item.start.ticks) < BigInt(item.end.ticks), 'KEEP_RANGE_OUT_OF_SOURCE', 'Keep range is outside the source.');
    return item;
  });
  else if (!input.enabled) kept = [whole];
  else {
    const min = BigInt(input.minimumSilenceMs) * TICKS_PER_SECOND / 1000n;
    const head = BigInt(input.keepHeadMs) * TICKS_PER_SECOND / 1000n;
    const tail = BigInt(input.keepTailMs) * TICKS_PER_SECOND / 1000n;
    const removed: TickRange[] = [];
    for (const silent of input.silence) {
      const clipped = intersect(silent, whole); if (!clipped || BigInt(clipped.end.ticks) - BigInt(clipped.start.ticks) < min) continue;
      let intervals = [range(BigInt(clipped.start.ticks) + head, BigInt(clipped.end.ticks) - tail)];
      for (const word of input.words) {
        const next: TickRange[] = [];
        for (const interval of intervals) {
          if (!intersect(interval, word.range)) { next.push(interval); continue; }
          if (BigInt(interval.start.ticks) < BigInt(word.range.start.ticks)) next.push(range(interval.start.ticks, word.range.start.ticks));
          if (BigInt(interval.end.ticks) > BigInt(word.range.end.ticks)) next.push(range(word.range.end.ticks, interval.end.ticks));
        }
        intervals = next;
      }
      removed.push(...intervals.filter(item => BigInt(item.start.ticks) < BigInt(item.end.ticks)));
    }
    removed.sort((a, b) => BigInt(a.start.ticks) < BigInt(b.start.ticks) ? -1 : 1);
    kept = []; let cursor = 0n;
    for (const cut of removed) { const start = BigInt(cut.start.ticks), end = BigInt(cut.end.ticks); if (start > cursor) kept.push(range(cursor, start)); if (end > cursor) cursor = end; }
    if (cursor < duration) kept.push(range(cursor, duration));
  }
  let previous = 0n; let timeline = 0n;
  return kept.map((sourceRange, index) => {
    const start = BigInt(sourceRange.start.ticks), end = BigInt(sourceRange.end.ticks);
    requireCondition(start >= previous, 'OVERLAPPING_KEEP_RANGES', 'Keep ranges must be ordered and non-overlapping.');
    for (const word of input.words) {
      const a = BigInt(word.range.start.ticks), z = BigInt(word.range.end.ticks);
      requireCondition(!(a < start && start < z) && !(a < end && end < z), 'SPOKEN_WORD_CUT', 'A cut boundary would split a spoken word.');
    }
    previous = end; const timelineRange = range(timeline, timeline + end - start); timeline += end - start;
    return { segmentKey: `speech-${index}`, sourceAssetId: input.sourceAssetId, sourceRange, timelineRange, speedNumerator: 1, speedDenominator: 1, reverse: false };
  });
}
export function remapRange(source: TickRange, segments: CutSegment[], sourceAssetId: string): TickRange[] {
  const result: TickRange[] = [];
  for (const segment of segments) {
    if (segment.sourceAssetId !== sourceAssetId) continue;
    const overlap = intersect(source, segment.sourceRange); if (!overlap) continue;
    requireCondition(!segment.reverse && segment.speedNumerator === 1 && segment.speedDenominator === 1, 'CAPTION_TIME_MAP_UNSUPPORTED', 'Captions require a supported explicit time map.');
    const offset = BigInt(segment.timelineRange.start.ticks) - BigInt(segment.sourceRange.start.ticks);
    result.push(range(BigInt(overlap.start.ticks) + offset, BigInt(overlap.end.ticks) + offset));
  }
  return result;
}
export function captionsFromWords(words: Word[], segments: CutSegment[], sourceAssetId: string, settings: {
  maxLines: number; maxCharsPerLine: number; minimumDurationMs: number; maximumDurationMs: number;
  uncertainWordsPolicy: string; confidenceThreshold: number;
}): Cue[] {
  const mapped = words.flatMap(word => {
    if (settings.uncertainWordsPolicy === 'error') requireCondition(word.confidence !== undefined && word.confidence >= settings.confidenceThreshold, 'LOW_CONFIDENCE_TRANSCRIPT', 'A required transcript word is uncertain.');
    return remapRange(word.range, segments, sourceAssetId).map(item => ({ ...word, range: item }));
  });
  const maxTicks = BigInt(settings.maximumDurationMs) * TICKS_PER_SECOND / 1000n;
  const minTicks = BigInt(settings.minimumDurationMs) * TICKS_PER_SECOND / 1000n;
  const cues: Cue[] = []; let chunk: typeof mapped = [];
  function flush(): void {
    if (!chunk.length) return;
    const lines: string[] = []; let line = '';
    for (const word of chunk) { const next = (line + (line && !/^\s/.test(word.word) ? ' ' : '') + word.word).trim(); if (line && [...next].length > settings.maxCharsPerLine) { lines.push(line); line = word.word.trim(); } else line = next; }
    if (line) lines.push(line);
    requireCondition(lines.length <= settings.maxLines && lines.every(value => [...value].length <= settings.maxCharsPerLine), 'CAPTION_OVERFLOW', 'Caption text does not fit the requested line limits.');
    cues.push({ cueKey: `cue-${cues.length + 1}`, text: lines.join('\n'), range: range(chunk[0]!.range.start.ticks, chunk.at(-1)!.range.end.ticks) }); chunk = [];
  }
  for (const word of mapped) {
    const chars = [...chunk.map(item => item.word).join(' ') + ' ' + word.word].length;
    if (chunk.length && (chars > settings.maxCharsPerLine * settings.maxLines || BigInt(word.range.end.ticks) - BigInt(chunk[0]!.range.start.ticks) > maxTicks || BigInt(word.range.start.ticks) - BigInt(chunk.at(-1)!.range.end.ticks) > TICKS_PER_SECOND)) flush();
    chunk.push(word);
  }
  flush();
  for (let index = 0; index < cues.length; index++) {
    const cue = cues[index]!; const next = cues[index + 1]; const minimumEnd = BigInt(cue.range.start.ticks) + minTicks;
    if (BigInt(cue.range.end.ticks) < minimumEnd) {
      const mapEnd = segments.find(segment => BigInt(segment.timelineRange.start.ticks) <= BigInt(cue.range.start.ticks) && BigInt(segment.timelineRange.end.ticks) >= BigInt(cue.range.end.ticks))?.timelineRange.end.ticks;
      const limit = next ? BigInt(next.range.start.ticks) : mapEnd ? BigInt(mapEnd) : BigInt(cue.range.end.ticks);
      requireCondition(minimumEnd <= limit, 'CAPTION_DURATION_UNSATISFIED', 'A caption cannot meet the minimum duration without overlapping or extending its mapped range.');
      cue.range.end.ticks = String(minimumEnd);
    }
  }
  return cues;
}
function timestamp(ticks: string, vtt: boolean): string {
  const ms = BigInt(ticks) * 1000n / TICKS_PER_SECOND;
  const hours = ms / 3_600_000n; const minutes = ms / 60_000n % 60n; const seconds = ms / 1000n % 60n;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${vtt ? '.' : ','}${String(ms % 1000n).padStart(3, '0')}`;
}
export function serializeCaptions(cues: Cue[], format: 'srt' | 'vtt', lineEnding: 'LF' | 'CRLF' = 'LF'): string {
  const newline = lineEnding === 'LF' ? '\n' : '\r\n'; const vtt = format === 'vtt';
  return (vtt ? 'WEBVTT' + newline + newline : '') + cues.map((cue, index) => `${vtt ? cue.cueKey : index + 1}${newline}${timestamp(cue.range.start.ticks, vtt)} --> ${timestamp(cue.range.end.ticks, vtt)}${newline}${cue.text.replace(/\r?\n/g, newline)}${newline}`).join(newline) + newline;
}
