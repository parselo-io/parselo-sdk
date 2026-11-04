// canonical.ts
// One stable output shape every document maps into, regardless of source
// (barcode now; OCR/MRZ later). Each field carries its value, a confidence,
// and which path produced it, so the future merge step can prefer ground truth.

import type { AamvaResult } from "./aamva";
import type { MagstripeResult } from "./magstripe";
import type { MrzResult } from "./mrz";
import type { IneCredential } from "./ine";
import type { OntarioHcResult } from "./ontario-hc";
import type { QuebecHcResult } from "./quebec-hc";

// Minimal ICAO 3-char → ISO 3166-1 alpha-2 map for jurisdiction derivation.
const ICAO_ISO2: Record<string, string> = {
  CAN: "CA", USA: "US", GBR: "GB", FRA: "FR", DEU: "DE", AUS: "AU",
  NZL: "NZ", JPN: "JP", CHN: "CN", IND: "IN", BRA: "BR", MEX: "MX",
  ITA: "IT", ESP: "ES", PRT: "PT", NLD: "NL", BEL: "BE", CHE: "CH",
  AUT: "AT", SWE: "SE", NOR: "NO", DNK: "DK", FIN: "FI", IRL: "IE",
  POL: "PL", CZE: "CZ", HUN: "HU", HRV: "HR", ROU: "RO", UKR: "UA",
  RUS: "RU", TUR: "TR", ISR: "IL", ZAF: "ZA", KOR: "KR", SGP: "SG",
  MYS: "MY", THA: "TH", IDN: "ID", PHL: "PH", PAK: "PK", EGY: "EG",
};

export type FieldSource = "barcode" | "ocr" | "mrz";

export interface CanonicalField {
  value: string;
  confidence: number;     // 0..1; barcode data is error-corrected, so ~1.0
  source: FieldSource;
}

export type DocumentType = "drivers_license" | "id_card" | "health_card" | "passport" | "ine" | "unknown";

export interface CanonicalDocument {
  documentType: DocumentType;
  jurisdiction: string;   // e.g. "CA-QC"
  fields: {
    firstName?: CanonicalField;
    lastName?: CanonicalField;
    middleName?: CanonicalField;
    dateOfBirth?: CanonicalField;   // ISO YYYY-MM-DD
    expiryDate?: CanonicalField;    // ISO YYYY-MM-DD
    issueDate?: CanonicalField;     // ISO YYYY-MM-DD
    documentNumber?: CanonicalField;
    sex?: CanonicalField;
    addressStreet?: CanonicalField;
    addressCity?: CanonicalField;
    addressRegion?: CanonicalField;
    addressPostalCode?: CanonicalField;
    country?: CanonicalField;
    vehicleClass?: CanonicalField;
  };
  raw: Record<string, string>;      // every parsed element, for debugging/QA
}

export function mrzToCanonical(m: MrzResult): CanonicalDocument {
  const c = m.confidence;
  const field = (value: string | undefined): CanonicalField | undefined =>
    value !== undefined ? { value, confidence: c, source: "mrz" } : undefined;

  const iso2 = m.issuingCountry ? (ICAO_ISO2[m.issuingCountry] ?? m.issuingCountry) : "unknown";

  return {
    documentType: "passport",
    jurisdiction: iso2,
    fields: {
      firstName:      field(m.firstName),
      lastName:       field(m.lastName),
      documentNumber: field(m.documentNumber),
      dateOfBirth:    field(m.dateOfBirth),
      expiryDate:     field(m.expiryDate),
      sex:            field(m.sex),
      country:        field(m.issuingCountry),
    },
    raw: {
      line1: m.raw.line1,
      line2: m.raw.line2,
    },
  };
}

export function magstripeToCanonical(m: MagstripeResult, confidence = 1.0): CanonicalDocument {
  const field = (value: string | undefined): CanonicalField | undefined =>
    value !== undefined ? { value, confidence, source: "barcode" } : undefined;

  const province = m.jurisdiction ?? m.addressRegion ?? "";
  const jurisdiction = province ? `CA-${province}` : "CA";

  return {
    documentType: m.isHealthCard ? "health_card" : "drivers_license",
    jurisdiction,
    fields: {
      firstName:        field(m.firstName),
      lastName:         field(m.lastName),
      dateOfBirth:      field(m.dateOfBirth),
      expiryDate:       field(m.expiryDate),
      // For a BC Health Card, the track-2 "document number" slot is
      // meaningless — the real Personal Health Number is recovered from
      // track 3 instead (see magstripe.ts).
      documentNumber:   field(m.healthNumber ?? m.documentNumber),
      sex:              field(m.sex),
      addressStreet:    field(m.addressStreet),
      addressCity:      field(m.addressCity),
      addressRegion:    field(m.addressRegion),
      addressPostalCode: field(m.addressPostalCode),
    },
    raw: {
      track1: m.raw.track1 ?? "",
      track2: m.raw.track2 ?? "",
      track3: m.raw.track3 ?? "",
    },
  };
}

export function toCanonical(a: AamvaResult, confidence = 1.0): CanonicalDocument {
  const e = a.elements;
  const field = (code: string): CanonicalField | undefined =>
    e[code] !== undefined ? { value: e[code], confidence, source: "barcode" } : undefined;

  const region = e["DAJ"] ?? "";
  const rawCountry = e["DCG"] ?? "";
  const countryPrefix = rawCountry === "CAN" ? "CA" : rawCountry === "USA" ? "US" : rawCountry;
  const jurisdiction = region
    ? `${countryPrefix || "??"}-${region}`
    : (countryPrefix || "unknown");

  const documentType: DocumentType = a.subfileTypes.includes("ID")
    ? "id_card"
    : "drivers_license";

  return {
    documentType,
    jurisdiction,
    fields: {
      firstName: field("DAC"),
      lastName: field("DCS"),
      middleName: field("DAD"),
      dateOfBirth: field("DBB"),
      expiryDate: field("DBA"),
      issueDate: field("DBD"),
      documentNumber: field("DAQ"),
      sex: field("DBC"),
      addressStreet: field("DAG"),
      addressCity: field("DAI"),
      addressRegion: field("DAJ"),
      addressPostalCode: field("DAK"),
      country: field("DCG"),
      vehicleClass: field("DCA"),
    },
    // iin/subfileTypes surfaced for debugging jurisdiction/issuer questions.
    raw: { ...e, iin: a.header?.iin ?? "", subfileTypes: a.subfileTypes.join(",") },
  };
}

export function ontarioHcToCanonical(o: OntarioHcResult, confidence = 0.7): CanonicalDocument {
  const field = (value: string | undefined): CanonicalField | undefined =>
    value !== undefined ? { value, confidence, source: "barcode" } : undefined;

  return {
    documentType: "health_card",
    jurisdiction: "CA-ON",
    fields: {
      firstName: field(o.firstName),
      lastName: field(o.lastName),
      dateOfBirth: field(o.dateOfBirth),
      issueDate: field(o.issueDate),
      expiryDate: field(o.expiryDate),
      documentNumber: field(o.healthNumber),
      country: field("CAN"),
    },
    raw: o.raw,
  };
}

export function quebecHcToCanonical(q: QuebecHcResult, confidence = 0.8): CanonicalDocument {
  const field = (value: string | undefined): CanonicalField | undefined =>
    value !== undefined && value !== "" ? { value, confidence, source: "barcode" } : undefined;

  return {
    documentType: "health_card",
    jurisdiction: "CA-QC",
    fields: {
      firstName: field(q.firstName),
      lastName: field(q.lastName),
      dateOfBirth: field(q.dateOfBirth),
      expiryDate: field(q.expiryDate),
      documentNumber: field(q.healthNumber),
      sex: field(q.sex),
      country: field("CAN"),
    },
    raw: q.raw,
  };
}

// Mexican naming has two surnames; there is no dedicated canonical slot for
// that, so paternal maps to lastName and maternal to middleName (same
// reuse-the-generic-shape approach as every other document type here).
// documentNumber prefers the CIC (from MRZ) since OCR/emissionNumber are not
// populated by the MRZ-only path this SDK currently implements.
export function ineToCanonical(i: IneCredential): CanonicalDocument {
  const source: FieldSource = i.source === "MRZ" ? "mrz" : "barcode";
  const confidence = i.source === "MRZ" ? 1.0 : 0.5; // PDF417 is best-effort/unimplemented today

  const field = (value: string | undefined): CanonicalField | undefined =>
    value !== undefined ? { value, confidence, source } : undefined;

  // integrity.* is stuffed into raw (stringified) rather than added as a typed
  // CanonicalDocument field, since raw is already documented as "every parsed
  // element, for debugging/QA" and every other document type keeps
  // format-specific data out of the shared `fields` shape. Never rename these
  // keys to imply "verified"/"valid" — see ine.ts's integrity boundary comment.
  const raw: Record<string, string> = {
    integrityOverall: i.integrity.overall,
    mrzCheckDigitsValid: String(i.integrity.mrzCheckDigitsValid),
    curpCheckDigitValid: String(i.integrity.curpCheckDigitValid),
    claveElectorStructureValid: String(i.integrity.claveElectorStructureValid),
    crossFieldConsistent: String(i.integrity.crossFieldConsistent),
  };
  if (i.mrzLines) {
    raw.mz1 = i.mrzLines.mz1;
    raw.mz2 = i.mrzLines.mz2;
    raw.mz3 = i.mrzLines.mz3;
  }
  if (i.curp) raw.curp = i.curp.value;
  if (i.claveElector) raw.claveElector = i.claveElector.value;

  return {
    documentType: "ine",
    jurisdiction: "MX",
    fields: {
      firstName: field(i.givenNames),
      lastName: field(i.surnamePaternal),
      middleName: field(i.surnameMaternal),
      dateOfBirth: field(i.dateOfBirth),
      sex: field(i.sex),
      documentNumber: field(i.cic ?? i.ocr),
      country: field("MEX"),
    },
    raw,
  };
}
