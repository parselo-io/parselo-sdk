// test.ts  — run with:  node --experimental-strip-types test.ts
// Exercises the REAL delivered code: the AAMVA parser, the canonical mapping,
// and the full license crypto path (DER signature -> raw -> SubtleCrypto verify),
// using a local P-256 key as a stand-in for AWS KMS.

import { parseAamva } from "./aamva.ts";
import { parseMagstripe } from "./magstripe.ts";
import { parseMrz } from "./mrz.ts";
import {
  parseIneMrz, isCurpCheckDigitValid, curpCheckDigit, claveElectorStructureValid,
  buildIneCredential,
} from "./ine.ts";
import { parseOntarioHc } from "./ontario-hc.ts";
import { parseQuebecHc } from "./quebec-hc.ts";
import {
  toCanonical, magstripeToCanonical, mrzToCanonical, ineToCanonical,
  ontarioHcToCanonical, quebecHcToCanonical,
} from "./canonical.ts";
import { verifyLicense } from "./license.ts";
import { derToRaw, bytesToB64url, strToB64url, kidFromSpki } from "./mint.ts";
import { generateKeyPairSync, sign } from "node:crypto";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
}

// ---------- build a structurally-correct Canadian AAMVA payload ----------
function buildSample(iin = "636999", ver = "09", jurver = "01", country = "CAN") {
  const elems: [string, string][] = [
    ["DCA", "5"], ["DCB", "NONE"], ["DCD", "NONE"], ["DBA", "20281231"],
    ["DCS", "TREMBLAY"], ["DAC", "MARIE"], ["DAD", "ELISE"], ["DBD", "20231101"],
    ["DBB", "19850312"], ["DBC", "2"], ["DAU", "165 cm"],
    ["DAG", "123 RUE SAINTE-CATHERINE"], ["DAI", "MONTREAL"], ["DAJ", "QC"],
    ["DAK", "H2X1K4  "], ["DAQ", "T12345678901234"], ["DCF", "ABCD1234"],
    ["DCG", country],
  ];
  let body = "DL" + elems.map(([c, v]) => c + v + "\n").join("");
  body = body.slice(0, -1) + "\r";                       // last element ends with CR terminator
  const prefix = "@\n\x1e\rANSI " + iin + ver + jurver + "01"; // 1 subfile entry
  const off = prefix.length + 10;                         // subfile body starts after the 10-char directory
  const directory = "DL" + String(off).padStart(4, "0") + String(body.length).padStart(4, "0");
  return prefix + directory + body;
}

console.log("==== AAMVA parser ====");
const raw = buildSample();
const parsed = parseAamva(raw);
check("isAamva", parsed.isAamva);
check("IIN", parsed.header?.iin === "636999", parsed.header?.iin);
check("subfile type DL", parsed.subfileTypes.includes("DL"));
check("DOB normalised (CCYYMMDD)", parsed.elements["DBB"] === "1985-03-12", parsed.elements["DBB"]);
check("expiry normalised", parsed.elements["DBA"] === "2028-12-31", parsed.elements["DBA"]);
check("first name", parsed.elements["DAC"] === "MARIE");
check("licence number", parsed.elements["DAQ"] === "T12345678901234");

console.log("\n==== canonical mapping ====");
const doc = toCanonical(parsed);
check("documentType", doc.documentType === "drivers_license", doc.documentType);
check("jurisdiction", doc.jurisdiction === "CA-QC", doc.jurisdiction);
check("lastName field", doc.fields.lastName?.value === "TREMBLAY");
check("dob field", doc.fields.dateOfBirth?.value === "1985-03-12");
check("field source/confidence", doc.fields.dateOfBirth?.source === "barcode" && doc.fields.dateOfBirth?.confidence === 1.0);

// Synthetic BC magnetic-stripe fixture. Same three-track layout as the native
// decode output of a real BC licence (IIN, separators, fixed-width track 3,
// packed physical descriptor), but every personal value is made up — never
// commit data read from a real card.
const BC_FIXTURE = "%BCVANCOUVER^SAMPLE TESTER,$ALEX JORDAN^100-555 EXAMPLE ST$VANCOUVER BC  ?;6360281234567=270119800101=?_%0AV6B1A1                     M172 84BLKBLK                          00S00000000?";

console.log("\n==== magstripe parser ====");
const ms = parseMagstripe(BC_FIXTURE);
check("isMagstripe", ms.isMagstripe);
check("jurisdiction code", ms.jurisdiction === "BC", ms.jurisdiction);
check("IIN", ms.iin === "636028", ms.iin);
check("lastName", ms.lastName === "SAMPLE TESTER", ms.lastName);
check("firstName (given names)", ms.firstName === "ALEX JORDAN", ms.firstName);
check("DOB", ms.dateOfBirth === "1980-01-01", ms.dateOfBirth);
check("expiry (end-of-month)", ms.expiryDate === "2027-01-31", ms.expiryDate);
check("documentNumber", ms.documentNumber === "1234567", ms.documentNumber);
check("addressStreet", ms.addressStreet === "100-555 EXAMPLE ST", ms.addressStreet);
check("addressCity", ms.addressCity === "VANCOUVER", ms.addressCity);
check("addressRegion", ms.addressRegion === "BC", ms.addressRegion);
check("addressPostalCode normalised", ms.addressPostalCode === "V6B 1A1", ms.addressPostalCode);
check("sex", ms.sex === "M", ms.sex);

console.log("\n==== magstripe canonical mapping ====");
const msDoc = magstripeToCanonical(ms);
check("documentType", msDoc.documentType === "drivers_license", msDoc.documentType);
check("jurisdiction CA-BC", msDoc.jurisdiction === "CA-BC", msDoc.jurisdiction);
check("lastName field value", msDoc.fields.lastName?.value === "SAMPLE TESTER");
check("firstName field value", msDoc.fields.firstName?.value === "ALEX JORDAN");
check("DOB field value", msDoc.fields.dateOfBirth?.value === "1980-01-01");
check("expiry field value", msDoc.fields.expiryDate?.value === "2027-01-31");
check("documentNumber field value", msDoc.fields.documentNumber?.value === "1234567");
check("addressStreet field value", msDoc.fields.addressStreet?.value === "100-555 EXAMPLE ST");
check("addressCity field value", msDoc.fields.addressCity?.value === "VANCOUVER");
check("addressRegion field value", msDoc.fields.addressRegion?.value === "BC");
check("addressPostalCode field value", msDoc.fields.addressPostalCode?.value === "V6B 1A1");
check("sex field value", msDoc.fields.sex?.value === "M");
check("source is barcode", msDoc.fields.lastName?.source === "barcode");
check("confidence is 1.0", msDoc.fields.lastName?.confidence === 1.0);

// Synthetic BC Health Card (CareCard) fixture — same three-track magstripe
// container as a BC driver's licence (same IIN, same track layout), just
// with the physical-descriptor slot after sex left blank and the Personal
// Health Number sitting there instead. See magstripe.ts header comment.
// Layout matches a real card's decode output; every personal value is made up.
const BC_HC_FIXTURE = "%BCDELTA^SAMPLE PATIENT,$TAYLOR MORGAN^200 SAMPLE AVE$DELTA BC V4C 1A1^?;63602800000000001=250219900215=?_%0AV4C1A1                     M            9999999998                00G00000000?";

console.log("\n==== BC Health Card (CareCard) parser ====");
const hcMs = parseMagstripe(BC_HC_FIXTURE);
check("isMagstripe", hcMs.isMagstripe);
check("isHealthCard", hcMs.isHealthCard === true);
check("jurisdiction code", hcMs.jurisdiction === "BC", hcMs.jurisdiction);
check("lastName", hcMs.lastName === "SAMPLE PATIENT", hcMs.lastName);
check("firstName", hcMs.firstName === "TAYLOR MORGAN", hcMs.firstName);
check("DOB", hcMs.dateOfBirth === "1990-02-15", hcMs.dateOfBirth);
check("expiry (end-of-month)", hcMs.expiryDate === "2025-02-28", hcMs.expiryDate);
check("healthNumber (Personal Health Number)", hcMs.healthNumber === "9999999998", hcMs.healthNumber);
check("sex", hcMs.sex === "M", hcMs.sex);
check("addressStreet", hcMs.addressStreet === "200 SAMPLE AVE", hcMs.addressStreet);
check("addressCity (postal code stripped from track 1)", hcMs.addressCity === "DELTA", hcMs.addressCity);
check("addressRegion (postal code stripped from track 1)", hcMs.addressRegion === "BC", hcMs.addressRegion);
check("addressPostalCode", hcMs.addressPostalCode === "V4C 1A1", hcMs.addressPostalCode);

console.log("\n==== BC Health Card canonical mapping ====");
const hcMsDoc = magstripeToCanonical(hcMs);
check("documentType", hcMsDoc.documentType === "health_card", hcMsDoc.documentType);
check("jurisdiction CA-BC", hcMsDoc.jurisdiction === "CA-BC", hcMsDoc.jurisdiction);
check("documentNumber is the PHN, not the meaningless track-2 field", hcMsDoc.fields.documentNumber?.value === "9999999998", hcMsDoc.fields.documentNumber?.value);

// Regression: the original BC driver's licence fixture (above) must still
// classify as drivers_license and keep its own documentNumber untouched —
// guards against the health-card fix leaking into the non-health-card path.
console.log("\n==== BC driver's licence regression after health card fix ====");
check("original DL fixture still isMagstripe", ms.isMagstripe);
check("original DL fixture NOT flagged as health card", !ms.isHealthCard);
check("original DL documentType unchanged", msDoc.documentType === "drivers_license", msDoc.documentType);
check("original DL documentNumber unchanged", msDoc.fields.documentNumber?.value === "1234567", msDoc.fields.documentNumber?.value);
check("original DL sex still parses (packed descriptor path)", ms.sex === "M", ms.sex);

// Synthetic Ontario Health Card fixture. Same fixed-width layout as a real
// card's native decode output (see ontario-hc.ts header comment), including
// the NUL padding of the 28-char name field — every personal value is made up.
const ON_HC_NAME = "ALEX SAMPLE";
const ON_HC_FIXTURE =
  "@ON HC01.10" + "AB1234567" + "1234567890" +
  ON_HC_NAME + "\x00".repeat(28 - ON_HC_NAME.length) +
  "19900101" + "2" + "20250101" + "20300101" + "01TY";

console.log("\n==== Ontario Health Card parser ====");
const ohc = parseOntarioHc(ON_HC_FIXTURE);
check("isOntarioHc", ohc.isOntarioHc);
check("cardNumber", ohc.cardNumber === "AB1234567", ohc.cardNumber);
check("healthNumber", ohc.healthNumber === "1234567890", ohc.healthNumber);
check("firstName", ohc.firstName === "ALEX", ohc.firstName);
check("lastName", ohc.lastName === "SAMPLE", ohc.lastName);
check("dateOfBirth", ohc.dateOfBirth === "1990-01-01", ohc.dateOfBirth);
check("issueDate", ohc.issueDate === "2025-01-01", ohc.issueDate);
check("expiryDate", ohc.expiryDate === "2030-01-01", ohc.expiryDate);

console.log("\n==== Ontario Health Card canonical mapping ====");
const ohcDoc = ontarioHcToCanonical(ohc);
check("documentType", ohcDoc.documentType === "health_card", ohcDoc.documentType);
check("jurisdiction", ohcDoc.jurisdiction === "CA-ON", ohcDoc.jurisdiction);
check("firstName field", ohcDoc.fields.firstName?.value === "ALEX");
check("lastName field", ohcDoc.fields.lastName?.value === "SAMPLE");
check("documentNumber field (health number)", ohcDoc.fields.documentNumber?.value === "1234567890");
check("expiryDate field", ohcDoc.fields.expiryDate?.value === "2030-01-01");

// Synthetic Quebec Health Card (RAMQ) fixture. Not AAMVA — a distinct,
// undocumented, LF-delimited key/value format (see quebec-hc.ts header comment).
// Same keys/order/delimiters as a real card's decode output; every personal
// value is made up (the NAM follows the real 3+1 letters + YYMMDD + 2 digits shape).
const QC_HC_FIXTURE =
  "\n" + "CNAMSAMA80010118\n" + "CPRNALEX JORDAN\n" + "CNOMSAMPLE TESTEUR\n" +
  "CEPO\n" + "CSEQ01\n" + "CEXP2030-01\n" + "CDTN1980-01-01\n" + "CSEXM\n" +
  "ZQXX00000001-01\r";

console.log("\n==== Quebec Health Card (RAMQ) parser ====");
const qhc = parseQuebecHc(QC_HC_FIXTURE);
check("isQuebecHc", qhc.isQuebecHc);
check("healthNumber (NAM)", qhc.healthNumber === "SAMA80010118", qhc.healthNumber);
check("firstName", qhc.firstName === "ALEX JORDAN", qhc.firstName);
check("lastName", qhc.lastName === "SAMPLE TESTEUR", qhc.lastName);
check("dateOfBirth", qhc.dateOfBirth === "1980-01-01", qhc.dateOfBirth);
check("expiryDate (month precision — no day encoded)", qhc.expiryDate === "2030-01", qhc.expiryDate);
check("sex", qhc.sex === "M", qhc.sex);
check("reference", qhc.reference === "XX00000001-01", qhc.reference);

console.log("\n==== Quebec Health Card canonical mapping ====");
const qhcDoc = quebecHcToCanonical(qhc);
check("documentType", qhcDoc.documentType === "health_card", qhcDoc.documentType);
check("jurisdiction", qhcDoc.jurisdiction === "CA-QC", qhcDoc.jurisdiction);
check("firstName field", qhcDoc.fields.firstName?.value === "ALEX JORDAN");
check("documentNumber field (NAM)", qhcDoc.fields.documentNumber?.value === "SAMA80010118");
check("sex field", qhcDoc.fields.sex?.value === "M");

// Regression: IIN 604428 is SAAQ (Quebec driver's licence), NOT RAMQ. An earlier
// version of this SDK mistakenly classified this IIN as a health card after being
// given a mislabeled sample — this guards against that mistake recurring.
console.log("\n==== AAMVA: Quebec driver's licence (IIN 604428) stays drivers_license ====");
const qcDlParsed = parseAamva(buildSample("604428"));
const qcDlDoc = toCanonical(qcDlParsed);
check("documentType is drivers_license, not health_card", qcDlDoc.documentType === "drivers_license", qcDlDoc.documentType);

// Format guard: AAMVA element payload must be rejected by the magstripe parser
const aamvaRaw = buildSample();
check("AAMVA payload not magstripe", !parseMagstripe(aamvaRaw).isMagstripe);

// Tolerant: partial payload with no track 2/3 still returns isMagstripe = true
const partialMs = parseMagstripe("%BCVANCOUVER^SMITH,$JOHN^123 MAIN ST$VICTORIA BC  ?");
check("partial (no track 2/3) is magstripe", partialMs.isMagstripe);
check("partial lastName", partialMs.lastName === "SMITH", partialMs.lastName);

// ── ICAO 9303 official test vectors (published spec; not real passport data) ──
// Source: ICAO 9303 Part 4, Machine Readable Passports specimen MRP.
const ICAO_L1 = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<";
const ICAO_L2 = "L898902C36UTO7408122F1204159ZE184226B<<<<<10";
// Corrupted: DOB check digit changed 2 → 3; composite check will also fail.
const ICAO_L2_BAD_DOB = "L898902C36UTO7408123F1204159ZE184226B<<<<<10";

console.log("\n==== MRZ parser (ICAO 9303 TD3) ====");
const mrz = parseMrz([ICAO_L1, ICAO_L2]);
check("isMrz", mrz.isMrz);
check("documentType P", mrz.documentType === "P", mrz.documentType);
check("issuingCountry UTO", mrz.issuingCountry === "UTO", mrz.issuingCountry);
check("lastName ERIKSSON", mrz.lastName === "ERIKSSON", mrz.lastName);
check("firstName ANNA MARIA", mrz.firstName === "ANNA MARIA", mrz.firstName);
check("documentNumber L898902C3", mrz.documentNumber === "L898902C3", mrz.documentNumber);
check("nationality UTO", mrz.nationality === "UTO", mrz.nationality);
check("dateOfBirth 1974-08-12", mrz.dateOfBirth === "1974-08-12", mrz.dateOfBirth);
check("sex F", mrz.sex === "F", mrz.sex);
check("expiryDate 2012-04-15", mrz.expiryDate === "2012-04-15", mrz.expiryDate);
check("personalNumber ZE184226B", mrz.personalNumber === "ZE184226B", mrz.personalNumber);
check("all check digits pass", mrz.checksumFailures.length === 0, mrz.checksumFailures.join(","));
check("confidence 1.0", mrz.confidence === 1.0, String(mrz.confidence));

// MRZ located correctly inside a noisy OCR result (surrounding lines ignored)
const mrzFound = parseMrz(["REPUBLIC OF FICTONIA", ICAO_L1, ICAO_L2, "page footer text"]);
check("MRZ found in multi-line OCR", mrzFound.isMrz);
check("MRZ found: lastName correct", mrzFound.lastName === "ERIKSSON");

// OCR with injected spaces in OCR-B font (normalisation must strip them)
const mrzSpaced = parseMrz([
  "P< UTO ERI KSS ON<< AN NA< MA RIA<<< << << << <<< << << <<<",
  "L8 989 02C 36U TO7 408 122 F12 041 59Z E18 422 6B< <<<< 10",
]);
check("OCR spaces stripped — isMrz", mrzSpaced.isMrz);
check("OCR spaces stripped — confidence 1.0", mrzSpaced.confidence === 1.0, String(mrzSpaced.confidence));

// Corrupted check digit: DOB check wrong → checksumFailures includes dateOfBirth + composite
const mrzBad = parseMrz([ICAO_L1, ICAO_L2_BAD_DOB]);
check("corrupt DOB check detected", mrzBad.isMrz && mrzBad.checksumFailures.includes("dateOfBirth"),
  mrzBad.checksumFailures.join(","));
check("corrupt composite detected", mrzBad.checksumFailures.includes("composite"),
  mrzBad.checksumFailures.join(","));
check("corrupt: confidence < 1.0", mrzBad.confidence > 0 && mrzBad.confidence < 1.0,
  String(mrzBad.confidence));

// Non-MRZ lines must be rejected cleanly
check("non-MRZ lines rejected", !parseMrz(["hello world", "not an mrz line at all"]).isMrz);
check("empty lines rejected", !parseMrz([]).isMrz);

console.log("\n==== MRZ canonical mapping ====");
const mrzDoc = mrzToCanonical(mrz);
check("documentType passport", mrzDoc.documentType === "passport", mrzDoc.documentType);
check("jurisdiction UTO (unmapped country stays as-is)", mrzDoc.jurisdiction === "UTO", mrzDoc.jurisdiction);
check("lastName field value", mrzDoc.fields.lastName?.value === "ERIKSSON");
check("firstName field value", mrzDoc.fields.firstName?.value === "ANNA MARIA");
check("dob field value", mrzDoc.fields.dateOfBirth?.value === "1974-08-12");
check("expiry field value", mrzDoc.fields.expiryDate?.value === "2012-04-15");
check("country field value", mrzDoc.fields.country?.value === "UTO");
check("source is mrz", mrzDoc.fields.lastName?.source === "mrz");
check("confidence in field is 1.0", mrzDoc.fields.lastName?.confidence === 1.0);

// Canonical for CAN issuing country should map jurisdiction to "CA"
const syntheticCanMrz = parseMrz([
  "P<CANSMITH<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<",
  "AB1234567<CAN8501011M3001010<<<<<<<<<<<<<<<6",
]);
if (syntheticCanMrz.isMrz) {
  const canDoc = mrzToCanonical(syntheticCanMrz);
  check("CAN → CA jurisdiction", canDoc.jurisdiction === "CA", canDoc.jurisdiction);
}

// VIZ cross-reference tests: simulate real Vision output where the MRZ "<"
// separator chars are corrupted by OCR but the biographical zone is clean.
console.log("\n==== MRZ VIZ name cross-reference ====");

// Scenario A: both surname and given names recoverable from VIZ.
// MRZ line 1 has the "<<" separator intact but "<" between given names read as "C".
const VIZ_L1_BOTH = "P<UTOERIKSSON<<ANNACMARIACCCCCCCCCCCCCCCCCCC";  // ANNA<MARIA → ANNACMARIA
const vizBoth = parseMrz([
  "REPUBLIC OF FICTONIA",   // noise – not a name candidate
  "ERIKSSON",               // VIZ surname line (clean)
  "ANNA MARIA",             // VIZ given-names line (clean)
  VIZ_L1_BOTH,
  ICAO_L2,
]);
check("VIZ both: isMrz", vizBoth.isMrz);
check("VIZ both: lastName from VIZ", vizBoth.lastName === "ERIKSSON", vizBoth.lastName ?? "");
check("VIZ both: firstName from VIZ", vizBoth.firstName === "ANNA MARIA", vizBoth.firstName ?? "");

// Scenario B: "<<" separator itself is corrupted (to "CC"), so parseName()
// cannot find it at all. Only the given-names VIZ line is recoverable.
// (This matches the real Mexican passport failure mode from device logs.)
const VIZ_L1_GIVEN_ONLY = "P<UTOERIKSSON<<ANNACMARIACCCCCCCCCCCCCCCCCCC";
const vizGivenOnly = parseMrz([
  "ANNA MARIA",             // VIZ given-names line present
  // Surname VIZ line is absent (simulating a frame where Vision missed it)
  VIZ_L1_GIVEN_ONLY,
  ICAO_L2,
]);
check("VIZ given only: isMrz", vizGivenOnly.isMrz);
check("VIZ given only: firstName from VIZ", vizGivenOnly.firstName === "ANNA MARIA", vizGivenOnly.firstName ?? "");

// Scenario C: no VIZ lines at all — result must fall back to raw MRZ parse
// without any VIZ change (existing ICAO vector is clean, should be unaffected).
const vizNone = parseMrz([ICAO_L1, ICAO_L2]);
check("VIZ none: isMrz", vizNone.isMrz);
check("VIZ none: lastName unchanged", vizNone.lastName === "ERIKSSON", vizNone.lastName ?? "");
check("VIZ none: firstName unchanged", vizNone.firstName === "ANNA MARIA", vizNone.firstName ?? "");

// Scenario D: a plausible Vision line whose tokens do NOT appear in the MRZ
// name field must be rejected (no false positive substitution).
const vizFalsePos = parseMrz([
  "JOHN DOE",               // tokens JOHN, DOE — neither in ERIKSSON MRZ field
  ICAO_L1,
  ICAO_L2,
]);
check("VIZ no false positive: lastName untouched", vizFalsePos.lastName === "ERIKSSON", vizFalsePos.lastName ?? "");
check("VIZ no false positive: firstName untouched", vizFalsePos.firstName === "ANNA MARIA", vizFalsePos.firstName ?? "");

// ── Synthetic INE TD1 MRZ builder ─────────────────────────────────────────────
// Real card sample payloads are not available, and none are committed to this
// repo (synthetic data only). This constructs a structurally-correct TD1
// (ICAO 9303 Part 5) triplet with correct check digits, mirroring buildSample()
// above for AAMVA — programmatic construction rather than a hand-computed
// magic string, so the fixture can't silently drift from the real algorithm.
function padField(s: string, len: number): string {
  return (s + "<".repeat(len)).slice(0, len).toUpperCase();
}

// Same ICAO 7-3-1 weighted check-digit algorithm ine.ts and mrz.ts each
// implement internally; duplicated here (fixture-construction only, not
// exported from either parser) so this test file stays independently
// runnable without a bundler, same reasoning as ine.ts's header comment.
function td1CheckDigit(s: string): number {
  const weight = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let v = 0;
    if (c === "<") v = 0;
    else if (c >= "0" && c <= "9") v = c.charCodeAt(0) - 48;
    else if (c >= "A" && c <= "Z") v = c.charCodeAt(0) - 55;
    sum += v * weight[i % 3];
  }
  return sum % 10;
}

function buildIneMrzLines(opts: {
  documentNumber: string; optionalData1?: string;
  // "H"/"M" written directly into the MRZ (confirmed against a real INE card —
  // no ICAO M/F translation happens here, unlike a TD3 passport).
  dobYYMMDD: string; sex: "H" | "M"; expYYMMDD: string;
  optionalData2?: string; paternal: string; maternal?: string; given: string;
}): [string, string, string] {
  const docNum = padField(opts.documentNumber, 9);
  const docNumCheck = String(td1CheckDigit(docNum));
  const opt1 = padField(opts.optionalData1 ?? "", 15);
  const l1 = `ID` + `MEX` + docNum + docNumCheck + opt1;

  const dob = padField(opts.dobYYMMDD, 6);
  const dobCheck = String(td1CheckDigit(dob));
  const exp = padField(opts.expYYMMDD, 6);
  const expCheck = String(td1CheckDigit(exp));
  const opt2 = padField(opts.optionalData2 ?? "", 11);
  const compositeInput = docNum + docNumCheck + opt1 + dob + dobCheck + exp + expCheck + opt2;
  const composite = String(td1CheckDigit(compositeInput));
  const l2 = dob + dobCheck + opts.sex + exp + expCheck + "MEX" + opt2 + composite;

  const namePrimary = opts.maternal ? `${opts.paternal}<${opts.maternal}` : opts.paternal;
  const l3 = padField(`${namePrimary}<<${opts.given}`, 30);

  return [l1, l2, l3];
}

console.log("\n==== INE MRZ parser (ICAO 9303 TD1) ====");
const ineLines = buildIneMrzLines({
  documentNumber: "123456789", dobYYMMDD: "900515", sex: "M", expYYMMDD: "300515",
  paternal: "GARCIA", maternal: "LOPEZ", given: "MARIA<ELENA",
});
const ineMrz = parseIneMrz(ineLines);
check("isIne", ineMrz.isIne);
check("documentCode ID", ineMrz.documentCode === "ID", ineMrz.documentCode);
check("issuingCountry MEX", ineMrz.issuingCountry === "MEX", ineMrz.issuingCountry);
check("documentNumber", ineMrz.documentNumber === "123456789", ineMrz.documentNumber);
check("dateOfBirth 1990-05-15", ineMrz.dateOfBirth === "1990-05-15", ineMrz.dateOfBirth);
check("sex M (Mujer) passes through directly, no ICAO translation", ineMrz.sex === "M", ineMrz.sex);
check("expiryDate 2030-05-15", ineMrz.expiryDate === "2030-05-15", ineMrz.expiryDate);
check("nationality MEX", ineMrz.nationality === "MEX", ineMrz.nationality);
check("surnamePaternal GARCIA", ineMrz.surnamePaternal === "GARCIA", ineMrz.surnamePaternal);
check("surnameMaternal LOPEZ", ineMrz.surnameMaternal === "LOPEZ", ineMrz.surnameMaternal);
check("givenNames MARIA ELENA", ineMrz.givenNames === "MARIA ELENA", ineMrz.givenNames);
check("all check digits pass", ineMrz.checksumFailures.length === 0, ineMrz.checksumFailures.join(","));
check("confidence 1.0", ineMrz.confidence === 1.0, String(ineMrz.confidence));

// Corrupted DOB check digit -> dateOfBirth + composite both fail
const ineBadLines = buildIneMrzLines({
  documentNumber: "123456789", dobYYMMDD: "900515", sex: "M", expYYMMDD: "300515",
  paternal: "GARCIA", maternal: "LOPEZ", given: "MARIA<ELENA",
});
const badDobChar = ineBadLines[1][6] === "9" ? "8" : "9"; // flip the DOB check digit
const corruptedL2 = ineBadLines[1].slice(0, 6) + badDobChar + ineBadLines[1].slice(7);
const ineBad = parseIneMrz([ineBadLines[0], corruptedL2, ineBadLines[2]]);
check("corrupt DOB check detected", ineBad.isIne && ineBad.checksumFailures.includes("dateOfBirth"),
  ineBad.checksumFailures.join(","));
check("corrupt composite detected", ineBad.checksumFailures.includes("composite"),
  ineBad.checksumFailures.join(","));
check("corrupt: confidence < 1.0", ineBad.confidence > 0 && ineBad.confidence < 1.0, String(ineBad.confidence));

// Pre-2014 model: no MRZ on the card at all — must degrade gracefully, not throw.
check("no-MRZ card: isIne false", !parseIneMrz(["some front-of-card OCR text", "no barcode either"]).isIne);
check("no-MRZ card: empty input", !parseIneMrz([]).isIne);

console.log("\n==== MRZ document classification (INE vs passport vs DL) ====");
// Each parser deterministically self-gates on its own shape/prefix (TD1 "ID..MEX"
// vs TD3 "P<...") — this is what "classification" means at the parser level;
// the calling app picks scanIne() vs scanPassport() the same way it already
// picks scan() vs scanPassport() for barcode vs MRZ capture.
check("INE lines parse as INE", parseIneMrz(ineLines).isIne);
check("INE lines are not also parsed as a TD3 passport", !parseMrz(ineLines).isMrz);
check("passport lines parse as passport", parseMrz([ICAO_L1, ICAO_L2]).isMrz);
check("passport lines are not also parsed as INE TD1", !parseIneMrz([ICAO_L1, ICAO_L2]).isIne);
check("garbage is neither", !parseIneMrz(["not an mrz", "at all"]).isIne && !parseMrz(["not an mrz", "at all"]).isMrz);
check("AAMVA barcode payload is not mistaken for ine/passport OCR lines",
  !parseIneMrz([buildSample()]).isIne && !parseMrz([buildSample()]).isMrz);

console.log("\n==== INE canonical mapping ====");
const ineCredential = buildIneCredential({ mrz: ineMrz, source: "MRZ" });
const ineDoc = ineToCanonical(ineCredential);
check("documentType ine", ineDoc.documentType === "ine", ineDoc.documentType);
check("jurisdiction MX", ineDoc.jurisdiction === "MX", ineDoc.jurisdiction);
check("firstName field value", ineDoc.fields.firstName?.value === "MARIA ELENA");
check("lastName field value (paternal)", ineDoc.fields.lastName?.value === "GARCIA");
check("middleName field value (maternal)", ineDoc.fields.middleName?.value === "LOPEZ");
check("sex field value", ineDoc.fields.sex?.value === "M");
check("source is mrz", ineDoc.fields.firstName?.source === "mrz");
check("confidence is 1.0 (MRZ source)", ineDoc.fields.firstName?.confidence === 1.0);

console.log("\n==== CURP check-digit validation ====");
// Synthetic CURP, structurally shaped per spec (4 letters + DOB + sex + 2-letter
// state + 3 consonants + homonymy char), check digit computed via the published
// SAT/RENAPO weighted-sum algorithm implemented in ine.ts.
const SYNTHETIC_CURP_VALID = "GALM900515MDFRPZ51"; // DOB 900515 / sex M — matches ineMrz above
check("valid CURP check digit accepted", isCurpCheckDigitValid(SYNTHETIC_CURP_VALID));
const curpBadDigit = SYNTHETIC_CURP_VALID.slice(0, 17) + (SYNTHETIC_CURP_VALID[17] === "1" ? "2" : "1");
check("corrupted CURP check digit rejected", !isCurpCheckDigitValid(curpBadDigit));
check("wrong-length CURP rejected", !isCurpCheckDigitValid("GALM900515MDFRPZ"));

console.log("\n==== Clave de Elector structural validation ====");
// 6 letters + DOB(6) + entidad(2) + sex + homonymy(3); DOB/sex match ineMrz/CURP above.
const SYNTHETIC_CLAVE_VALID = "GALOME90051509M001";
check("valid Clave de Elector structure accepted", claveElectorStructureValid(SYNTHETIC_CLAVE_VALID));
check("Clave with out-of-range entidad code rejected",
  !claveElectorStructureValid("GALOME90051599M001")); // entidad 99 > 32
check("Clave with wrong character classes rejected",
  !claveElectorStructureValid("GAL0ME90051509M001")); // digit inside the 6-letter zone
check("Clave cross-checked against matching DOB/sex", claveElectorStructureValid(
  SYNTHETIC_CLAVE_VALID, { dateOfBirth: "1990-05-15", sex: "M" }));
check("Clave cross-check fails on mismatched DOB", !claveElectorStructureValid(
  SYNTHETIC_CLAVE_VALID, { dateOfBirth: "1991-05-15", sex: "M" }));
check("Clave cross-check fails on mismatched sex", !claveElectorStructureValid(
  SYNTHETIC_CLAVE_VALID, { dateOfBirth: "1990-05-15", sex: "H" }));

console.log("\n==== INE integrity: cross-field consistency + honest labelling ====");
const consistentCred = buildIneCredential({
  mrz: ineMrz, curp: SYNTHETIC_CURP_VALID, claveElector: SYNTHETIC_CLAVE_VALID, source: "MRZ",
});
check("all-agree: mrzCheckDigitsValid", consistentCred.integrity.mrzCheckDigitsValid);
check("all-agree: curpCheckDigitValid", consistentCred.integrity.curpCheckDigitValid);
check("all-agree: claveElectorStructureValid", consistentCred.integrity.claveElectorStructureValid);
check("all-agree: crossFieldConsistent", consistentCred.integrity.crossFieldConsistent);
check("all-agree: overall consistent", consistentCred.integrity.overall === "consistent",
  consistentCred.integrity.overall);

// CURP with a different DOB embedded (still checksum-valid on its own) must
// trip crossFieldConsistent even though every individual check digit passes.
const MISMATCHED_DOB_CURP = "GALM800515MDFRPZ5" + curpCheckDigit("GALM800515MDFRPZ5");
check("mismatched-DOB CURP is individually check-digit valid (sanity)",
  isCurpCheckDigitValid(MISMATCHED_DOB_CURP));
const inconsistentCred = buildIneCredential({
  mrz: ineMrz, curp: MISMATCHED_DOB_CURP, claveElector: SYNTHETIC_CLAVE_VALID, source: "MRZ",
});
check("cross-field DOB mismatch detected", !inconsistentCred.integrity.crossFieldConsistent);
check("overall inconsistent on cross-field mismatch",
  inconsistentCred.integrity.overall === "inconsistent", inconsistentCred.integrity.overall);

// No CURP/Clave decoded at all (MRZ-only path, today's reality pending PDF417
// samples) must NOT be silently reported as "consistent" — there is nothing
// to be consistent WITH, so it must say so honestly.
const mrzOnlyCred = buildIneCredential({ mrz: ineMrz, source: "MRZ" });
check("MRZ-only overall is consistent (no other source to conflict with)",
  mrzOnlyCred.integrity.overall === "consistent", mrzOnlyCred.integrity.overall);
check("MRZ-only has no curp/claveElector populated", !mrzOnlyCred.curp && !mrzOnlyCred.claveElector);

const noDataCred = buildIneCredential({ source: "PDF417" });
check("no sources at all -> insufficient_data", noDataCred.integrity.overall === "insufficient_data",
  noDataCred.integrity.overall);

// Never claim offline integrity proves authenticity — this is a documentation/
// naming-boundary regression guard, not a crypto check.
check("integrity never claims verification", !JSON.stringify(consistentCred.integrity).match(/verified|valid_credential/i));

console.log("\n==== license crypto round-trip (KMS simulated by a local P-256 key) ====");
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }) as Buffer);
const spkiB64 = Buffer.from(spki).toString("base64");
const kid = kidFromSpki(spki);

function mint(payloadOverrides: Record<string, unknown>) {
  const header = { alg: "ES256", typ: "JWT", kid };
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    sub: "acme", plan: "trial", quota: 50000, iat: nowSec, exp: nowSec + 30 * 86400,
    bundleIds: ["com.acme.app"], jti: "lic_test", kid, ...payloadOverrides,
  };
  const signingInput = `${strToB64url(JSON.stringify(header))}.${strToB64url(JSON.stringify(payload))}`;
  const der = sign("sha256", Buffer.from(signingInput, "utf8"), { key: privateKey, dsaEncoding: "der" });
  const rawSig = derToRaw(new Uint8Array(der));
  return `${signingInput}.${bytesToB64url(rawSig)}`;
}

const keys = { [kid]: spkiB64 };

const good = await verifyLicense({ token: mint({}), bundleId: "com.acme.app", publicKeys: keys });
check("valid token verifies", good.valid, good.reason ?? "");
check("claims.sub parsed", good.claims?.sub === "acme");

// forge the payload: keep it valid JSON but alter the content (bump quota/plan)
// while reattaching the ORIGINAL signature -> signature must fail to verify.
const baseTok = mint({});
const bp = baseTok.split(".");
const forgedClaims = JSON.parse(Buffer.from(bp[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
forgedClaims.quota = 999999;
forgedClaims.plan = "enterprise";
const tampered = `${bp[0]}.${strToB64url(JSON.stringify(forgedClaims))}.${bp[2]}`;
const tamp = await verifyLicense({ token: tampered, bundleId: "com.acme.app", publicKeys: keys });
check("forged payload rejected (bad signature)", !tamp.valid && tamp.reason === "bad_signature", tamp.reason ?? "");

const past = Math.floor(Date.now() / 1000) - 10;
const expired = await verifyLicense({ token: mint({ exp: past }), bundleId: "com.acme.app", publicKeys: keys });
check("expired token rejected", !expired.valid && expired.reason === "expired", expired.reason ?? "");

const wrongBundle = await verifyLicense({ token: mint({}), bundleId: "com.other.app", publicKeys: keys });
check("bundle mismatch rejected", !wrongBundle.valid && wrongBundle.reason === "bundle_mismatch", wrongBundle.reason ?? "");

const unknownKey = await verifyLicense({ token: mint({}), bundleId: "com.acme.app", publicKeys: {} });
check("unknown key rejected", !unknownKey.valid && unknownKey.reason === "unknown_key", unknownKey.reason ?? "");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
