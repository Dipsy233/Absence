/**
 * Token estimation from text length.
 *
 * Absence never inspects model responses semantically, so real token counts
 * are unavailable from the protocol. This module is the one shared heuristic:
 * a CJK character is roughly one token in modern tokenizers, and non-CJK text
 * averages roughly one token per four characters (English prose, JSON, code).
 * The result is an estimate and every consumer must present it as one — the
 * `usage` event carries `estimated: true` for exactly that reason.
 */

/** Roughly how many bytes/chars of non-CJK text one token spans. */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate the token count of a text. Pure arithmetic, no tables to go stale:
 * CJK code points (Han, Hiragana, Katakana, Hangul, fullwidth forms) count as
 * one token each; everything else is divided by the average chars-per-token.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (isCjk(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / CHARS_PER_TOKEN);
}

function isCjk(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // CJK radicals, kana, unified ideographs
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xff00 && code <= 0xffef) || // fullwidth forms
    (code >= 0x1100 && code <= 0x11ff) || // Hangul jamo
    (code >= 0x3130 && code <= 0x318f) || // Hangul compatibility jamo
    (code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
    (code >= 0x20000 && code <= 0x2ffff) // CJK extension B+
  );
}
