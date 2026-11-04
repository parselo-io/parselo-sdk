// ine.ts
// Mexican INE ("Credencial para Votar") — MRZ (ICAO 9303 TD1) parser, CURP /
// Clave de Elector offline integrity checks, and a stubbed PDF417 path.
//
// INE cards issued 2014+ carry a 3-line, 30-char-per-line TD1 MRZ. The line
// segmentation and check-digit algorithm below are the same ICAO 7-3-1
// scheme mrz.ts uses for TD3 passports, duplicated rather than imported:
// every parser file in this package is self-contained (no cross-parser
// imports anywhere) because src/test.ts runs each file directly through
// Node's ESM loader with no bundler, which requires exact-extension
// specifiers on relative imports — the opposite of the extension-less
// specifiers the tsc "Bundler" resolution mode expects for the real build.
// Keeping parser files standalone avoids straddling both requirements.
//
// IMPORTANT — what this module does NOT do:
// It does not verify the card against INE's Lista Nominal registry (that is
// an off-device service requiring a convenio with INE, explicit cardholder
// consent, and a paid aggregator; it is out of scope — see root README).
// Everything here runs on-device, offline, and proves only internal
// consistency ("does this look like a well-formed, non-garbled, non-typo'd
// card"), never document authenticity. Do not relabel `integrity.overall` as
// "valid" or "verified" anywhere downstream — that would misrepresent what
// an offline check can prove.

// ─── ICAO 7-3-1 check-digit algorithm (see mrz.ts header comment above) ──────

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

function resolveYear(yy: number, mustBePast: boolean): number {
  const now = new Date().getFullYear();
  const century = Math.floor(now / 100) * 100;
  const candidate = century + yy;
  if (mustBePast && candidate > now) return candidate - 100;
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

// ─── TD1 line location & normalisation ───────────────────────────────────────

// Normalise an OCR line to exactly 30 chars for TD1 (mirrors toTd3Line in mrz.ts,
// tolerant of the same +/-1 char OCR drop/add errors).
function toTd1Line(raw: string): string | null {
  const s = raw.replace(/\s/g, "").toUpperCase();
  if (s.length === 30) return s;
  if (s.length === 29) return s + "<";
  if (s.length === 31) return s.slice(0, 30);
  return null;
}

// ICAO 9303 reserves this slot for the English M/F sex code, so it would be
// reasonable to assume INE follows suit and translates to its own H (Hombre)
// / M (Mujer) convention. It does not: confirmed against a real card, INE
// writes the Spanish letter directly into this MRZ position with no ICAO
// translation — raw 'M' here already means Mujer, not "male". Pass it
// through verbatim; do not "normalise" it against the ICAO convention.
function readIneSex(c: string | undefined): string | undefined {
  return c === "H" || c === "M" ? c : undefined;
}

function parseIneName(field: string): {
  surnamePaternal?: string;
  surnameMaternal?: string;
  givenNames?: string;
} {
  const idx = field.indexOf("<<");
  const primary = idx === -1 ? field : field.slice(0, idx);
  const secondary = idx === -1 ? "" : field.slice(idx + 2);
  const [paternal, maternal] = primary.split("<").map(s => s.trim()).filter(Boolean);
  const givenNames = secondary.replace(/</g, " ").trim();
  return {
    surnamePaternal: paternal || undefined,
    surnameMaternal: maternal || undefined,
    givenNames: givenNames || undefined,
  };
}

export interface IneMrzResult {
  isIne: boolean;
  documentCode?: string;       // e.g. "ID"
  issuingCountry?: string;     // ICAO 3-char country code, "MEX"
  documentNumber?: string;     // CIC/OCR reference encoded in line 1 (model-dependent)
  optionalData1?: string;      // raw line-1 optional zone; contents are issuer/model-specific
  dateOfBirth?: string;        // ISO YYYY-MM-DD
  sex?: string;                // "H" | "M", as printed directly in the MRZ (no ICAO translation)
  expiryDate?: string;         // ISO YYYY-MM-DD
  nationality?: string;        // ICAO 3-char code, "MEX"
  optionalData2?: string;      // raw line-2 optional zone; contents are issuer/model-specific
  surnamePaternal?: string;
  surnameMaternal?: string;
  givenNames?: string;
  confidence: number;          // 0..1; derived from check-digit pass rate
  checksumFailures: string[];  // names of fields whose check digit failed
  raw: { line1: string; line2: string; line3: string };
}

function parseTd1(l1: string, l2: string, l3: string): IneMrzResult {
  const failures: string[] = [];
  const verify = (label: string, data: string, expectedChar: string) => {
    const expected = parseInt(expectedChar, 10);
    if (isNaN(expected) || checkDigit(data) !== expected) failures.push(label);
  };

  // ── Line 1 (document code, issuing country, document number) ──────────
  const documentCode = l1.slice(0, 2);
  const issuingCountry = l1.slice(2, 5).replace(/</g, "");
  const docNumField = l1.slice(5, 14);
  const docNumCheck = l1[14];
  const optionalData1 = l1.slice(15, 30);

  // ── Line 2 (biographic data) ────────────────────────────────────────────
  const dobField = l2.slice(0, 6);
  const dobCheck = l2[6];
  const sexChar = l2[7];
  const expField = l2.slice(8, 14);
  const expCheck = l2[14];
  const nationality = l2.slice(15, 18).replace(/</g, "");
  const optionalData2 = l2.slice(18, 29);
  const composite = l2[29];

  verify("documentNumber", docNumField, docNumCheck);
  verify("dateOfBirth", dobField, dobCheck);
  verify("expiryDate", expField, expCheck);

  // ICAO 9303-5 TD1 composite: docNumber+check, optionalData1, DOB+check,
  // expiry+check, optionalData2 (50 chars total), checked against line2[29].
  verify(
    "composite",
    docNumField + docNumCheck + optionalData1 + dobField + dobCheck + expField + expCheck + optionalData2,
    composite,
  );

  const totalChecks = 4;
  const passed = totalChecks - failures.length;
  const confidence = Math.max(0, passed / totalChecks);

  const { surnamePaternal, surnameMaternal, givenNames } = parseIneName(l3);

  return {
    isIne: true,
    documentCode,
    issuingCountry: issuingCountry || undefined,
    documentNumber: docNumField.replace(/</g, "") || undefined,
    optionalData1: optionalData1.replace(/</g, "") || undefined,
    dateOfBirth: parseMrzDate(dobField, true),
    sex: readIneSex(sexChar),
    expiryDate: parseMrzDate(expField, false),
    nationality: nationality || undefined,
    optionalData2: optionalData2.replace(/</g, "") || undefined,
    surnamePaternal,
    surnameMaternal,
    givenNames,
    confidence,
    checksumFailures: failures,
    raw: { line1: l1, line2: l2, line3: l3 },
  };
}

/**
 * Find and parse an INE TD1 MRZ from an array of OCR-recognised text lines.
 * Mirrors parseMrz()'s tolerant line-location strategy, but for the 3×30-char
 * TD1 shape instead of TD3's 2×44. Requires a Mexico-issued ID-class document
 * code (documentCode starting "I", issuingCountry "MEX") so this never
 * collides with a Canadian/US TD1 or a TD3 passport pair.
 */
export function parseIneMrz(lines: string[]): IneMrzResult {
  const empty: IneMrzResult = {
    isIne: false, confidence: 0, checksumFailures: [],
    raw: { line1: "", line2: "", line3: "" },
  };

  const flat = lines.flatMap(l => l.split(/\n/));

  for (let i = 0; i < flat.length - 2; i++) {
    const l1 = toTd1Line(flat[i]);
    const l2 = toTd1Line(flat[i + 1]);
    const l3 = toTd1Line(flat[i + 2]);
    if (!l1 || !l2 || !l3) continue;
    if (/^I[A-Z<]MEX/.test(l1)) return parseTd1(l1, l2, l3);
  }

  return empty;
}

// ─── CURP check-digit validation ─────────────────────────────────────────────
// Implements the published SAT/RENAPO CURP check-digit formula: a weighted
// sum over positions 1-17 against a fixed 37-character alphabet, weight =
// (18 - position). This is the same algorithm used for the Mexican RFC.
// Structural positions (letters/digits/H|M) are NOT re-derived here beyond
// what the check-digit computation itself requires — see claveElectorStructureValid
// for the fuller positional validation pattern this mirrors.

const CURP_ALPHABET = "0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ";

/** Compute the expected 18th (check) digit for a CURP, or undefined if malformed. */
export function curpCheckDigit(curp: string): number | undefined {
  if (!/^[A-ZÑ0-9]{17}/.test(curp)) return undefined;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const value = CURP_ALPHABET.indexOf(curp[i]);
    if (value === -1) return undefined;
    sum += value * (18 - i);
  }
  return (10 - (sum % 10)) % 10;
}

/** Validate a CURP's check digit. Does not confirm the CURP exists in RENAPO's registry. */
export function isCurpCheckDigitValid(curp: string): boolean {
  if (curp.length !== 18) return false;
  const expected = curpCheckDigit(curp);
  return expected !== undefined && String(expected) === curp[17];
}

// ─── Clave de Elector structural validation ──────────────────────────────────
// No published checksum exists for the Clave de Elector, so this validates
// character-class structure, a plausible entidad (state) code, and — when a
// DOB/sex from another source is supplied — cross-field agreement only.
// Structure: 6 letters (name-derived) + 6 digits (DOB, YYMMDD) +
// 2 digits (entidad code, 01-32) + "H"|"M" (sex) + 3 digits (homonymy).

const CLAVE_ELECTOR_RE = /^[A-Z]{6}(\d{6})(\d{2})([HM])(\d{3})$/;

export function claveElectorStructureValid(
  clave: string,
  cross?: { dateOfBirth?: string; sex?: string },
): boolean {
  const m = CLAVE_ELECTOR_RE.exec(clave);
  if (!m) return false;

  const [, dobYyMmDd, entidad, sex] = m;
  const entidadCode = parseInt(entidad, 10);
  if (entidadCode < 1 || entidadCode > 32) return false;

  if (cross?.dateOfBirth) {
    const expected = yyMmDdFromIso(cross.dateOfBirth);
    if (expected && expected !== dobYyMmDd) return false;
  }
  if (cross?.sex && cross.sex !== sex) return false;

  return true;
}

// ─── Cross-field consistency (DOB/sex must agree across every source present) ─

function yyMmDdFromIso(iso: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? m[1].slice(2) + m[2] + m[3] : undefined;
}

function crossFieldConsistent(mrz: IneMrzResult | undefined, curp: string | undefined, claveElector: string | undefined): boolean {
  const dobCandidates: string[] = [];
  const sexCandidates: string[] = [];

  const mrzDob = mrz?.dateOfBirth ? yyMmDdFromIso(mrz.dateOfBirth) : undefined;
  if (mrzDob) dobCandidates.push(mrzDob);
  if (mrz?.sex) sexCandidates.push(mrz.sex);

  if (curp && curp.length === 18) {
    dobCandidates.push(curp.slice(4, 10));        // CURP: 4 letters, then DOB YYMMDD
    const curpSex = curp[10];                     // "H" | "M"
    if (curpSex === "H" || curpSex === "M") sexCandidates.push(curpSex);
  }

  const claveMatch = claveElector ? CLAVE_ELECTOR_RE.exec(claveElector) : null;
  if (claveMatch) {
    dobCandidates.push(claveMatch[1]);
    sexCandidates.push(claveMatch[3]);
  }

  const dobAgree = dobCandidates.every(d => d === dobCandidates[0]);
  const sexAgree = sexCandidates.every(s => s === sexCandidates[0]);
  return dobAgree && sexAgree;
}

// ─── PDF417 (secondary, best-effort) — stubbed pending real sample payloads ──
// INE's PDF417 encoding is proprietary and undocumented (NOT AAMVA — do not
// route it through aamva.ts). Guessing at a proprietary binary/text layout
// without real device-captured samples to validate against would risk
// silently emitting wrong field values as if authoritative, which is exactly
// what the confidence-gating requirement in the task exists to prevent.
// TODO(ine-pdf417): implement once redacted real sample payloads (per model
// letter) are available; wire confidence-gated fields into buildIneCredential.

export interface IneBarcodeResult {
  supported: false;
  reason: "unsupported_format";
}

export function parseInePdf417(_raw: string): IneBarcodeResult {
  return { supported: false, reason: "unsupported_format" };
}

// ─── Typed result model + integrity assembly ─────────────────────────────────

export interface IneIntegrity {
  mrzCheckDigitsValid: boolean;
  curpCheckDigitValid: boolean;
  claveElectorStructureValid: boolean;
  crossFieldConsistent: boolean;
  // "consistent"/"inconsistent" describe internal agreement ONLY — never
  // treat either as proof the card is genuine, current, or registered with INE.
  overall: "consistent" | "inconsistent" | "insufficient_data";
}

export interface IneCredential {
  documentType: "MX_INE";
  model: string;                // detected model letter/generation, else "unknown"
  surnamePaternal?: string;
  surnameMaternal?: string;
  givenNames?: string;
  fullNameRaw?: string;
  dateOfBirth?: string;         // ISO YYYY-MM-DD
  sex?: string;                 // "H" | "M"
  claveElector?: { value: string; structureValid: boolean };
  curp?: { value: string; checkDigitValid: boolean };
  seccion?: string;             // electoral section — model-dependent, not populated by MRZ
  expiryYear?: string;
  registrationYear?: string;    // año de registro — model-dependent, not populated by MRZ
  emissionNumber?: string;      // model-dependent, not populated by MRZ
  ocr?: string;                 // model-dependent, not populated by MRZ
  cic?: string;                 // Clave del Identificador del Ciudadano, from MRZ document number
  mrzLines?: { mz1: string; mz2: string; mz3: string };
  source: "MRZ" | "PDF417";
  integrity: IneIntegrity;
}

function computeOverall(
  mrzPresent: boolean, curpPresent: boolean, clavePresent: boolean,
  mrzOk: boolean, curpOk: boolean, claveOk: boolean, crossOk: boolean,
): IneIntegrity["overall"] {
  if (!mrzPresent && !curpPresent && !clavePresent) return "insufficient_data";
  const anyFailure =
    (mrzPresent && !mrzOk) || (curpPresent && !curpOk) || (clavePresent && !claveOk) || !crossOk;
  return anyFailure ? "inconsistent" : "consistent";
}

/**
 * Assemble a typed IneCredential + honest offline-integrity signal from
 * whatever sources decoded successfully. `curp`/`claveElector` are optional
 * because today only the MRZ path is implemented (PDF417 is stubbed above,
 * pending real samples) and the MRZ does not carry either identifier — pass
 * them in once a future source (PDF417 or OCR) can supply them.
 */
export function buildIneCredential(input: {
  mrz?: IneMrzResult;
  curp?: string;
  claveElector?: string;
  model?: string;
  source?: "MRZ" | "PDF417";
}): IneCredential {
  const mrz = input.mrz?.isIne ? input.mrz : undefined;

  const mrzCheckDigitsValid = mrz ? mrz.checksumFailures.length === 0 : false;
  const curpOk = input.curp !== undefined ? isCurpCheckDigitValid(input.curp) : false;
  const claveOk = input.claveElector !== undefined
    ? claveElectorStructureValid(input.claveElector, { dateOfBirth: mrz?.dateOfBirth, sex: mrz?.sex })
    : false;
  const crossOk = crossFieldConsistent(mrz, input.curp, input.claveElector);

  const overall = computeOverall(
    !!mrz, input.curp !== undefined, input.claveElector !== undefined,
    mrzCheckDigitsValid, curpOk, claveOk, crossOk,
  );

  return {
    documentType: "MX_INE",
    model: input.model ?? "unknown",
    surnamePaternal: mrz?.surnamePaternal,
    surnameMaternal: mrz?.surnameMaternal,
    givenNames: mrz?.givenNames,
    fullNameRaw: mrz?.raw.line3,
    dateOfBirth: mrz?.dateOfBirth,
    sex: mrz?.sex,
    claveElector: input.claveElector !== undefined
      ? { value: input.claveElector, structureValid: claveOk }
      : undefined,
    curp: input.curp !== undefined
      ? { value: input.curp, checkDigitValid: curpOk }
      : undefined,
    expiryYear: mrz?.expiryDate?.slice(0, 4),
    cic: mrz?.documentNumber,
    mrzLines: mrz ? { mz1: mrz.raw.line1, mz2: mrz.raw.line2, mz3: mrz.raw.line3 } : undefined,
    source: input.source ?? (mrz ? "MRZ" : "PDF417"),
    integrity: {
      mrzCheckDigitsValid,
      curpCheckDigitValid: curpOk,
      claveElectorStructureValid: claveOk,
      crossFieldConsistent: crossOk,
      overall,
    },
  };
}
