// mrz.ts
// ICAO 9303 TD3 two-line × 44-char MRZ parser with full check-digit validation.
// TD1/TD2 (ID-card) formats are out of scope and left for future work.
//
// Usage from scanner-core:
//   parseMrz(lines)  — pass all OCR lines; function locates the TD3 pair.

export interface MrzResult {
  isMrz: boolean;
  documentType?: string;       // "P" for passport
  issuingCountry?: string;     // ICAO 3-char country code, e.g. "CAN"
  lastName?: string;
  firstName?: string;          // full given-name field; may be multi-word
  documentNumber?: string;
  nationality?: string;        // ICAO 3-char code
  dateOfBirth?: string;        // ISO YYYY-MM-DD
  sex?: string;                // "M" | "F"  (<  is normalised to undefined)
  expiryDate?: string;         // ISO YYYY-MM-DD
  personalNumber?: string;
  confidence: number;          // 0..1; derived from check-digit pass rate
  checksumFailures: string[];  // names of fields whose check digit failed
  raw: { line1: string; line2: string };
}

// ─── ICAO 7-3-1 check-digit algorithm ────────────────────────────────────────

const WEIGHT = [7, 3, 1] as const;

function charValue(c: string): number {
  if (c === "<") return 0;
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;        // '0'–'9'
  if (code >= 65 && code <= 90) return code - 55;        // 'A'–'Z' → 10–35
  return 0;
}

function checkDigit(s: string): number {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += charValue(s[i]) * WEIGHT[i % 3];
  return sum % 10;
}

// ─── 2-digit year resolution ─────────────────────────────────────────────────

function resolveYear(yy: number, mustBePast: boolean): number {
  const now    = new Date().getFullYear();
  const century = Math.floor(now / 100) * 100;
  const candidate = century + yy;
  // DOB must be in the past; if the candidate is a future year, step back a century.
  if (mustBePast && candidate > now) return candidate - 100;
  // Expiry/issue: if candidate is implausibly far in the past (> 50 years ago),
  // step forward a century — handles the century rollover for long-lived documents.
  if (!mustBePast && candidate < now - 50) return candidate + 100;
  return candidate;
}

function parseMrzDate(yymmdd: string, mustBePast: boolean): string | undefined {
  if (!/^\d{6}$/.test(yymmdd)) return undefined;
  const yy = parseInt(yymmdd.slice(0, 2), 10);
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  return `${resolveYear(yy, mustBePast)}-${mm}-${dd}`;
}

// ─── Name parsing ─────────────────────────────────────────────────────────────

function parseName(field: string): { lastName: string; firstName: string } {
  // SURNAME<<GIVEN<NAMES<<…  — primary and secondary identifiers split by <<
  const idx = field.indexOf("<<");
  if (idx === -1) return { lastName: field.replace(/</g, " ").trim(), firstName: "" };
  const lastName  = field.slice(0, idx).replace(/</g, " ").trim();
  const firstName = field.slice(idx + 2).replace(/</g, " ").trim();
  return { lastName, firstName };
}

// ─── Core TD3 parser (expects exactly two 44-char lines) ──────────────────────

function parseTd3(l1: string, l2: string): MrzResult {
  const failures: string[] = [];

  const verify = (label: string, data: string, expectedChar: string) => {
    const expected = parseInt(expectedChar, 10);
    if (isNaN(expected) || checkDigit(data) !== expected) failures.push(label);
  };

  // ── Line 1 ──────────────────────────────────────────
  const documentType   = l1[0];
  const issuingCountry = l1.slice(2, 5).replace(/</g, "");
  const { lastName, firstName } = parseName(l1.slice(5, 44));

  // ── Line 2 ──────────────────────────────────────────
  const docNumField = l2.slice(0, 9);
  const docNumCheck = l2[9];
  const nationality = l2.slice(10, 13).replace(/</g, "");
  const dobField    = l2.slice(13, 19);
  const dobCheck    = l2[19];
  const sexChar     = l2[20];
  const expField    = l2.slice(21, 27);
  const expCheck    = l2[27];
  const persField   = l2.slice(28, 42);
  const persCheck   = l2[42];
  const composite   = l2[43];

  // ── Check digits ─────────────────────────────────────
  verify("documentNumber", docNumField, docNumCheck);
  verify("dateOfBirth",    dobField,    dobCheck);
  verify("expiryDate",     expField,    expCheck);

  // Personal-number check: ICAO allows "<" when the field is unused/absent.
  let totalChecks = 4; // docNum + DOB + expiry + composite
  if (persCheck !== "<") {
    verify("personalNumber", persField, persCheck);
    totalChecks = 5;
  }

  // Composite covers positions 1–10, 14–20, 22–43 of line 2 (0-based: [0:10],[13:20],[21:43])
  verify("composite", l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, 43), composite);

  const passed     = totalChecks - failures.length;
  const confidence = Math.max(0, passed / totalChecks);

  return {
    isMrz:         true,
    documentType,
    issuingCountry: issuingCountry || undefined,
    lastName:       lastName       || undefined,
    firstName:      firstName      || undefined,
    documentNumber: docNumField.replace(/</g, "") || undefined,
    nationality:    nationality    || undefined,
    dateOfBirth:    parseMrzDate(dobField, true),
    sex:            (sexChar && sexChar !== "<") ? sexChar : undefined,
    expiryDate:     parseMrzDate(expField, false),
    personalNumber: persField.replace(/</g, "") || undefined,
    confidence,
    checksumFailures: failures,
    raw: { line1: l1, line2: l2 },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

// ─── VIZ (biographical zone) name cross-reference ────────────────────────────
//
// The OCR-B MRZ font encodes word separators as "<".  Vision and ML Kit
// frequently misread "<" as "C", "S", "K", "@", "&", "/" etc., making the
// MRZ name field unreliable.  However, Vision also reads the standard-font
// biographical zone above the MRZ (surname row, given-names row) with high
// accuracy because that zone uses a regular typeface with no fill characters.
//
// Strategy:
//   1. After parseTd3 produces a (possibly garbled) name, scan all non-MRZ
//      Vision lines for "name candidates" – short all-Latin-letter lines
//      whose uppercase tokens ALL appear verbatim in the raw 39-char MRZ
//      name field.
//   2. Sort candidates by their earliest token position in the name field:
//      the surname always starts before the given names in TD3.
//   3. Override lastName / firstName with the clean biographical-zone values.

// Words that commonly appear in Vision results as standalone lines but are
// NOT personal name components.
const VIZ_SKIP_TOKENS = new Set([
  "PASSPORT","PASAPORTE","TRAVEL","DOCUMENT","EMERGENCY","CANADA","MEXICO",
  "MEXICANA","MEXICANO","CANADIAN","CANADIENNE","NATIONALITY","NATIONAL",
  "RESIDENCE","RESIDENT","PERMANENT","SURNAME","GIVEN","NAMES","DATE","BIRTH",
  "EXPIRY","ISSUED","AUTHORITY","SIGNATURE","SEX","SEXE","TYPE","ISSUING",
  "FEDERAL","REPUBLIC","OFFICIAL","HOLDER","OTTAWA","GATINEAU","GOVERNMENT",
  "UNITED","STATES","KINGDOM","COMMONWEALTH","FOREIGN","AFFAIRS","INTERIOR",
]);

function isVizNameCandidate(line: string): boolean {
  if (/\d/.test(line)) return false;            // rejects dates, IDs, etc.
  const up = line.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]+$/.test(up)) return false;       // must be pure ASCII uppercase after removing spaces
  const words = line.trim().toUpperCase().split(/\s+/).filter(w => w.length >= 2);
  if (words.length === 0 || words.length > 4) return false;
  return !words.some(w => VIZ_SKIP_TOKENS.has(w));
}

function vizNameTokens(s: string): string[] {
  return (s.toUpperCase().match(/[A-Z]{3,}/g) ?? []);
}

function refineNamesFromViz(result: MrzResult, flat: string[], mrzIdx: number): void {
  if (!result.isMrz) return;

  // The raw 39-char name field from line 1 may contain OCR-corrupted separators.
  const rawName = result.raw.line1.slice(5, 44).toUpperCase();

  const nonMrz = flat.filter((_, i) => i !== mrzIdx && i !== mrzIdx + 1);

  interface Candidate { clean: string; firstPos: number }
  const candidates: Candidate[] = [];

  for (const line of nonMrz) {
    if (!isVizNameCandidate(line)) continue;
    const clean = line.trim().toUpperCase().replace(/\s+/g, " ");
    const tokens = vizNameTokens(clean).filter(t => t.length >= 3);
    if (tokens.length === 0) continue;

    // Every token of this Vision line must appear somewhere in the raw MRZ name field.
    const hits = tokens.filter(t => rawName.includes(t));
    if (hits.length < tokens.length) continue;

    const firstPos = Math.min(...tokens.map(t => rawName.indexOf(t)).filter(p => p >= 0));
    if (!candidates.some(c => c.clean === clean)) {
      candidates.push({ clean, firstPos });
    }
  }

  if (candidates.length === 0) return;

  // Surname always starts at or near position 0 in the name field;
  // given names follow the "<<" separator (position ≥ ~10).
  candidates.sort((a, b) => a.firstPos - b.firstPos);

  const first  = candidates[0];
  const second = candidates[1];

  if (first.firstPos <= 5) {
    result.lastName  = first.clean;
    if (second) result.firstName = second.clean;
  } else {
    // Only given names were recoverable from VIZ (surname was too corrupted).
    result.firstName = first.clean;
  }
}

// Normalise an OCR line to exactly 44 chars for TD3:
// - Strip whitespace (Vision / ML Kit insert spaces in OCR-B)
// - Uppercase
// - If 43 chars: pad with "<" (OCR commonly drops a trailing filler char)
// - If 45 chars: trim to 44 (OCR occasionally adds one)
// - Otherwise return null (too far off to be a TD3 line)
function toTd3Line(raw: string): string | null {
  const s = raw.replace(/\s/g, "").toUpperCase();
  if (s.length === 44) return s;
  if (s.length === 43) return s + "<";
  if (s.length === 45) return s.slice(0, 44);
  return null;
}

/**
 * Find and parse a TD3 MRZ from an array of OCR-recognised text lines.
 * Handles passports (P<), emergency travel documents (PU), permanent resident
 * travel documents (PR), and any other ICAO TD3 document type starting with P.
 *
 * Lines are normalised (spaces stripped, uppercased) before matching; lines
 * within ±1 char of the required 44 are accepted with padding/trimming.
 * Each element may also contain newline-separated sub-lines (some OCR engines
 * return both MRZ rows as one observation).
 */
export function parseMrz(lines: string[]): MrzResult {
  const empty: MrzResult = {
    isMrz: false, confidence: 0, checksumFailures: [], raw: { line1: "", line2: "" },
  };

  // Flatten: split on newlines in case the OCR engine joined both MRZ rows.
  const flat = lines.flatMap(l => l.split(/\n/));
  console.log("[parseMrz] input lines:", flat.length, flat.map(l => `"${l.replace(/\s/g,"").slice(0,10)}…(${l.replace(/\s/g,"").length})"`));

  for (let i = 0; i < flat.length - 1; i++) {
    const l1 = toTd3Line(flat[i]);
    const l2 = toTd3Line(flat[i + 1]);
    if (!l1 || !l2) continue;
    if (/^P[A-Z<]/.test(l1)) {
      console.log("[parseMrz] TD3 pair found at index", i, "→ parsing");
      const result = parseTd3(l1, l2);
      refineNamesFromViz(result, flat, i);
      return result;
    }
  }
  console.log("[parseMrz] no TD3 pair found in", flat.length, "lines");
  return empty;
}
