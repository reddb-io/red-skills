export interface PreservedOutlierLine {
  lineNumber: number;
  score: number;
  text: string;
}

export interface AnomalyScoreOptions {
  maxOutliers?: number;
  minScore?: number;
  excludedByteRanges?: readonly ByteRange[];
}

interface ByteRange {
  start: number;
  end: number;
}

interface LineStats {
  index: number;
  start: number;
  end: number;
  text: string;
  signature: string;
  tokens: string[];
  numbers: number[];
  length: number;
}

const DEFAULT_MAX_OUTLIERS = 3;
const DEFAULT_MIN_SCORE = 7;

export function scoreStructuralOutliers(text: string, options: AnomalyScoreOptions = {}): PreservedOutlierLine[] {
  const lines = splitLines(text);
  if (lines.length < 12) return [];

  const tokenFrequency = new Map<string, number>();
  const signatureFrequency = new Map<string, number>();
  for (const line of lines) {
    signatureFrequency.set(line.signature, (signatureFrequency.get(line.signature) ?? 0) + 1);
    for (const token of new Set(line.tokens)) tokenFrequency.set(token, (tokenFrequency.get(token) ?? 0) + 1);
  }

  const lengths = lines.map((line) => line.length);
  const tokenCounts = lines.map((line) => line.tokens.length);
  const numericMaxes = lines.map((line) => line.numbers.length === 0 ? 0 : Math.max(...line.numbers.map(Math.abs)));
  const lengthDeviation = deviationModel(lengths);
  const tokenDeviation = deviationModel(tokenCounts);
  const numericDeviation = deviationModel(numericMaxes);
  const excluded = options.excludedByteRanges ?? [];

  return lines
    .filter((line) => line.text.trim().length > 0)
    .filter((line) => !excluded.some((range) => rangesOverlap(line.start, line.end, range.start, range.end)))
    .map((line) => ({
      line,
      score:
        zScore(line.length, lengthDeviation) +
        zScore(line.tokens.length, tokenDeviation) +
        zScore(line.numbers.length === 0 ? 0 : Math.max(...line.numbers.map(Math.abs)), numericDeviation) +
        rareTokenScore(line.tokens, tokenFrequency, lines.length) +
        rareSignatureScore(line.signature, signatureFrequency, lines.length),
    }))
    .filter((entry) => entry.score >= (options.minScore ?? DEFAULT_MIN_SCORE))
    .sort((a, b) => b.score - a.score || a.line.index - b.line.index)
    .slice(0, options.maxOutliers ?? DEFAULT_MAX_OUTLIERS)
    .sort((a, b) => a.line.index - b.line.index)
    .map((entry) => ({
      lineNumber: entry.line.index + 1,
      score: Math.round(entry.score * 100) / 100,
      text: entry.line.text,
    }));
}

function splitLines(text: string): LineStats[] {
  const out: LineStats[] = [];
  let start = 0;
  let index = 0;
  for (const match of text.matchAll(/\n/g)) {
    const end = match.index ?? text.length;
    out.push(lineStats(index++, start, end, text.slice(start, end).replace(/\r$/, "")));
    start = end + 1;
  }
  if (start < text.length || text.length === 0) out.push(lineStats(index, start, text.length, text.slice(start).replace(/\r$/, "")));
  return out;
}

function lineStats(index: number, start: number, end: number, text: string): LineStats {
  return {
    index,
    start,
    end,
    text,
    signature: structuralSignature(text),
    tokens: normalizedTokens(text),
    numbers: numericFields(text),
    length: text.length,
  };
}

function structuralSignature(text: string): string {
  return text
    .replace(/[A-Z]+/g, "A")
    .replace(/[a-z]+/g, "a")
    .replace(/\d+(?:\.\d+)?/g, "0")
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

function normalizedTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_.:/-]{3,}/g) ?? [];
}

function numericFields(text: string): number[] {
  return [...text.matchAll(/[-+]?\d+(?:\.\d+)?/g)]
    .map((match) => Number(match[0]))
    .filter((value) => Number.isFinite(value));
}

function rareTokenScore(tokens: readonly string[], frequency: ReadonlyMap<string, number>, totalLines: number): number {
  const unique = [...new Set(tokens)];
  if (unique.length === 0) return 0;
  const rareScores = unique
    .map((token) => Math.log2(totalLines / Math.max(1, frequency.get(token) ?? totalLines)))
    .sort((a, b) => b - a)
    .slice(0, 6);
  return rareScores.reduce((sum, value) => sum + value, 0) / Math.max(1, rareScores.length);
}

function rareSignatureScore(signature: string, frequency: ReadonlyMap<string, number>, totalLines: number): number {
  return Math.log2(totalLines / Math.max(1, frequency.get(signature) ?? totalLines));
}

function deviationModel(values: readonly number[]): { median: number; mad: number } {
  const medianValue = median(values);
  const mad = median(values.map((value) => Math.abs(value - medianValue))) || 1;
  return { median: medianValue, mad };
}

function zScore(value: number, model: { median: number; mad: number }): number {
  return Math.abs(value - model.median) / model.mad;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 1 ? sorted[mid]! : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}
