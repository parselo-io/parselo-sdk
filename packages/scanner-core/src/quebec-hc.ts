// quebec-hc.ts
// Quebec Health Card (RAMQ — Régie de l'assurance maladie du Québec) PDF417
// payload parser.
//
// Not AAMVA/ANSI D-20 — a distinct, undocumented, LF-delimited key/value
// format. Reverse-engineered from a single real card; treat as best-effort.
// Each line (after a leading blank line and before a trailing CR) is a
// 4-letter field code immediately followed by its value, with no delimiter
// in between, except the final line, which starts with the 2-letter
// jurisdiction code "ZQ" instead.
//
//   CNAM   RAMQ health insurance number (NAM) — 4 letters + 6-digit DOB (YYMMDD) + 2-digit sequence
//   CPRN   given name(s) (prénom)
//   CNOM   surname (nom)
//   CEPO   unidentified, seen empty
//   CSEQ   card sequence number
//   CEXP   expiry, YYYY-MM (month precision only — no day encoded)
//   CDTN   date of birth (date de naissance), YYYY-MM-DD
//   CSEX   sex
//   ZQ...  card reference number (matches the "Référence" printed on the card)

export interface QuebecHcResult {
  isQuebecHc: boolean;
  healthNumber?: string;   // CNAM (the NAM)
  firstName?: string;
  lastName?: string;
  sequenceNumber?: string;
  dateOfBirth?: string;    // ISO YYYY-MM-DD
  expiryDate?: string;     // ISO YYYY-MM, best-effort (no day encoded)
  sex?: string;
  reference?: string;
  raw: Record<string, string>;
}

const FIELD_RE = /^([A-Z]{4})(.*)$/;

export function parseQuebecHc(raw: string): QuebecHcResult {
  const result: QuebecHcResult = { isQuebecHc: false, raw: {} };
  const lines = raw.replace(/\r$/, "").split("\n").filter((l) => l.length > 0);
  if (lines.length === 0 || !lines[0].startsWith("CNAM")) return result;
  result.isQuebecHc = true;

  for (const line of lines) {
    if (line.startsWith("ZQ")) {
      result.raw.reference = line.slice(2);
      continue;
    }
    const m = line.match(FIELD_RE);
    if (!m) continue;
    result.raw[m[1]] = m[2];
  }

  result.healthNumber = result.raw["CNAM"];
  result.firstName = result.raw["CPRN"];
  result.lastName = result.raw["CNOM"];
  result.sequenceNumber = result.raw["CSEQ"];
  result.sex = result.raw["CSEX"];
  result.reference = result.raw["reference"];

  const dob = result.raw["CDTN"];
  result.dateOfBirth = dob && /^\d{4}-\d{2}-\d{2}$/.test(dob) ? dob : undefined;

  const exp = result.raw["CEXP"];
  result.expiryDate = exp && /^\d{4}-\d{2}$/.test(exp) ? exp : undefined;

  return result;
}
