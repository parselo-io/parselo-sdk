// ontario-hc.ts
// Ontario Health Card PDF417 payload parser.
//
// Unlike AAMVA, ServiceOntario has never published a spec for this barcode.
// The layout below is reverse-engineered from a single real card, with
// dateOfBirth/issueDate/expiryDate cross-checked against the dates printed
// on that card. Still best-effort — confirm against a couple more cards
// before relying on it beyond display.
//
// Observed layout after the "@ON HC<version>" header, fixed-width, no
// delimiters:
//   cardNumber   9 chars   2 letters + 7 digits, e.g. "AB1234567" (printed on the card face)
//   healthNumber 10 digits e.g. "1234567890" (the OHIP number)
//   name         28 chars  "FIRST LAST", trailing-padded to width
//   dateOfBirth  8 digits  CCYYMMDD
//   ?            1 digit   unidentified, skipped
//   issueDate    8 digits  CCYYMMDD
//   expiryDate   8 digits  CCYYMMDD (immediately follows issueDate, no gap)

export interface OntarioHcResult {
  isOntarioHc: boolean;
  version?: string;
  cardNumber?: string;
  healthNumber?: string;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;   // ISO YYYY-MM-DD, best-effort
  issueDate?: string;     // ISO YYYY-MM-DD, best-effort
  expiryDate?: string;    // ISO YYYY-MM-DD, best-effort
  raw: Record<string, string>;
}

const HEADER_RE = /^@ON HC(\d{2}\.\d{2})/;

function isoDate(digits: string): string | undefined {
  return /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(digits)
    ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
    : undefined;
}

export function parseOntarioHc(raw: string): OntarioHcResult {
  const result: OntarioHcResult = { isOntarioHc: false, raw: {} };
  const header = raw.match(HEADER_RE);
  if (!header) return result;
  result.isOntarioHc = true;
  result.version = header[1];

  let i = header[0].length;
  const cardNumber = raw.slice(i, i + 9); i += 9;
  const healthNumber = raw.slice(i, i + 10); i += 10;
  const nameField = raw.slice(i, i + 28); i += 28;
  const dob = raw.slice(i, i + 8); i += 8;
  i += 1; // unidentified single-digit field, skipped — see header comment
  const issued = raw.slice(i, i + 8); i += 8;
  const expiry = raw.slice(i, i + 8); i += 8;

  if (/^[A-Z]{2}\d{7}$/.test(cardNumber)) result.cardNumber = cardNumber;
  if (/^\d{10}$/.test(healthNumber)) result.healthNumber = healthNumber;

  // Field is padded with NUL bytes to a fixed width.
  const nameParts = nameField.split(String.fromCharCode(0)).join("").trim().split(/\s+/).filter(Boolean);
  if (nameParts.length > 1) {
    result.firstName = nameParts[0];
    result.lastName = nameParts.slice(1).join(String.fromCharCode(32));
  } else if (nameParts.length === 1) {
    result.lastName = nameParts[0];
  }

  result.dateOfBirth = isoDate(dob);
  result.issueDate = isoDate(issued);
  result.expiryDate = isoDate(expiry);

  result.raw.cardNumber = cardNumber;
  result.raw.healthNumber = healthNumber;
  result.raw.name = nameParts.join(String.fromCharCode(32));
  result.raw.dateOfBirthRaw = dob;
  result.raw.issueDateRaw = issued;
  result.raw.expiryDateRaw = expiry;

  return result;
}
