// magstripe.ts
// Parser for the AAMVA magnetic-stripe track format used by some Canadian provinces
// (confirmed BC; likely ON/AB). Three tracks concatenated in one PDF417 payload:
//   Track 1  %...?   jurisdiction + name + address
//   Track 2  ;...?   IIN + document number + expiry (YYMM) + DOB (CCYYMMDD)
//   Track 3  ...?    postal code + physical description (layout varies by jurisdiction)
//
// Reference: AAMVA DL/ID Card Design Standard, magnetic-stripe annex.
//
// BC also issues its Health Card (CareCard) in this exact same three-track
// container — same IIN, same fixed-width track 3 layout, same column position
// for sex — just with the driver's-licence-only fields (height/weight/eye/hair
// colour) left blank and the Personal Health Number sitting in that gap
// instead. The track-2 "document number" slot does NOT hold the PHN for a
// health card (its value there is meaningless for this document type); the
// PHN has to be recovered from track 3. This has been reverse-engineered from
// a single real CareCard — see isHealthCard/healthNumber detection below.

export interface MagstripeResult {
  isMagstripe: boolean;
  isHealthCard?: boolean;     // true if this looks like a BC Health Card (CareCard), not a driver's licence
  jurisdiction?: string;      // 2-letter province code from track-1 header
  iin?: string;               // 6-digit Issuer Identification Number from track 2
  lastName?: string;
  firstName?: string;         // full given-name field; may be multi-word
  dateOfBirth?: string;       // ISO YYYY-MM-DD
  expiryDate?: string;        // ISO YYYY-MM-DD; day is end-of-month (day precision absent)
  documentNumber?: string;    // driver's licence number; meaningless when isHealthCard (see healthNumber)
  healthNumber?: string;      // Personal Health Number, populated only when isHealthCard
  sex?: string;               // "M" | "F"
  addressStreet?: string;
  addressCity?: string;
  addressRegion?: string;     // 2-letter province code from address
  addressPostalCode?: string; // normalised "ANA NAN"
  raw: {
    track1?: string;
    track2?: string;
    track3?: string;
  };
}

// Returns the last calendar day of a 1-based month in the given year.
function lastDayOfMonth(year: number, month: number): number {
  // Date(y, m, 0) with 0-indexed month m = last day of month (m-1); passing 1-based month directly works.
  return new Date(year, month, 0).getDate();
}

function applyTrack1(out: MagstripeResult, t1: string): void {
  // Format: jurisdiction(2) + city + ^ + SURNAME[,]$GIVEN NAMES + ^ + STREET$CITY PROVINCE
  const parts = t1.split("^");
  if (parts.length < 2) return;

  out.jurisdiction = parts[0].slice(0, 2);

  const namePart = parts[1];
  const dollar = namePart.indexOf("$");
  if (dollar !== -1) {
    out.lastName  = namePart.slice(0, dollar).replace(/,+$/, "").trim();
    out.firstName = namePart.slice(dollar + 1).trim();
  } else {
    out.lastName = namePart.replace(/,+$/, "").trim();
  }

  if (parts.length < 3) return;

  const addrPart = parts[2].trim();
  const addrDollar = addrPart.indexOf("$");
  if (addrDollar === -1) {
    out.addressStreet = addrPart;
    return;
  }

  out.addressStreet = addrPart.slice(0, addrDollar).trim();
  const cityProvRaw = addrPart.slice(addrDollar + 1).trim();

  // Some cards (confirmed: BC Health Card) append the postal code after the
  // province here, with an optional space in the middle ("BC V4C 6K4"); strip
  // it before splitting city from province — it's already extracted more
  // reliably from track 3's unspaced form.
  const cityProv = cityProvRaw.replace(/\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d$/, "").trim();

  // Province is the trailing space-separated token (always 2 chars); city is the rest.
  const lastSpace = cityProv.lastIndexOf(" ");
  if (lastSpace !== -1) {
    out.addressCity   = cityProv.slice(0, lastSpace).trim();
    out.addressRegion = cityProv.slice(lastSpace + 1).trim();
  } else if (cityProv.length >= 2) {
    out.addressRegion = cityProv.slice(-2);
    out.addressCity   = cityProv.slice(0, -2).trim();
  }
}

function applyTrack2(out: MagstripeResult, t2: string): void {
  // Format: IIN(6) + document-number + = + expiry-YYMM(4) + DOB-CCYYMMDD(8) + = + [discretionary]
  if (t2.length < 7) return;

  out.iin = t2.slice(0, 6);

  const eq1 = t2.indexOf("=");
  if (eq1 === -1) return;

  out.documentNumber = t2.slice(6, eq1);

  const after = t2.slice(eq1 + 1);
  if (after.length < 12) return;

  const expiryYYMM  = after.slice(0, 4);
  const dobCCYYMMDD = after.slice(4, 12);

  if (/^\d{4}$/.test(expiryYYMM)) {
    const yy   = parseInt(expiryYYMM.slice(0, 2), 10);
    const mm   = parseInt(expiryYYMM.slice(2, 4), 10);
    const year = yy < 70 ? 2000 + yy : 1900 + yy;
    const day  = lastDayOfMonth(year, mm);
    out.expiryDate = `${year}-${String(mm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  if (/^\d{8}$/.test(dobCCYYMMDD)) {
    out.dateOfBirth =
      `${dobCCYYMMDD.slice(0, 4)}-${dobCCYYMMDD.slice(4, 6)}-${dobCCYYMMDD.slice(6, 8)}`;
  }
}

function applyTrack3(out: MagstripeResult, t3: string): void {
  // Track 3 layout varies by jurisdiction — extract only what we can identify reliably.

  // Canadian postal code: letter-digit-letter-digit-letter-digit (no space in raw)
  const postalMatch = t3.match(/([A-Z]\d[A-Z]\d[A-Z]\d)/);
  let afterPostal = t3;
  if (postalMatch) {
    const p = postalMatch[1];
    out.addressPostalCode = `${p.slice(0, 3)} ${p.slice(3)}`;
    afterPostal = t3.slice(postalMatch.index! + postalMatch[0].length);
  }

  // Sex sits in a fixed slot after the postal code + padding, on a driver's
  // licence immediately followed by a packed physical descriptor
  // ("M172 84BLKBLK" = height/weight/eye/hair). Search only after the postal
  // code so a postal code's own letters can't be mistaken for this field.
  const sexMatch = afterPostal.match(/([MF])(\d{3})?/);
  if (!sexMatch) return;
  out.sex = sexMatch[1];
  if (sexMatch[2]) return; // digits immediately follow -> driver's licence descriptor block, nothing else to extract

  // No physical descriptor after sex -> reverse-engineered signal for a BC
  // Health Card (CareCard), confirmed on one real card. The Personal Health
  // Number sits later in the same track as a bare, space-padded digit run
  // (10 digits on the one card seen so far; allow a little slack either way).
  // This assumes the PHN is the *first* such run encountered — true on the
  // one sample checked, not verified against a second.
  const afterSex = afterPostal.slice((sexMatch.index ?? 0) + 1);
  const phnMatch = afterSex.match(/(\d{8,11})/);
  if (phnMatch) {
    out.isHealthCard = true;
    out.healthNumber = phnMatch[1];
  }
}

export function parseMagstripe(raw: string): MagstripeResult {
  const out: MagstripeResult = { isMagstripe: false, raw: {} };

  // Strip leading control/whitespace for format detection; keep raw intact for track extraction.
  const s = raw.replace(/^[\x00-\x1f\s]+/, "");
  if (!s.startsWith("%")) return out;

  // Track 1: % sentinel to first ?
  const t1End = s.indexOf("?");
  if (t1End === -1) return out;
  const t1 = s.slice(1, t1End);
  if (!t1.includes("^")) return out; // must have the field-separator to be a DL track 1

  out.isMagstripe = true;
  out.raw.track1 = t1;
  applyTrack1(out, t1);

  // Track 2: ; sentinel somewhere after track 1
  const after1 = s.slice(t1End + 1);
  const t2SentinelPos = after1.indexOf(";");
  if (t2SentinelPos === -1) return out;

  const t2ContentStart = t2SentinelPos + 1;
  const t2End = after1.indexOf("?", t2ContentStart);
  if (t2End === -1) return out;

  const t2 = after1.slice(t2ContentStart, t2End);
  out.raw.track2 = t2;
  applyTrack2(out, t2);

  // Track 3: everything after track 2's ? up to the last ? in the string.
  // Inter-track bytes (e.g. "_%0A" — an underscore + percent-encoded LF) are stripped.
  const afterT2 = after1.slice(t2End + 1);
  const t3LastQ = afterT2.lastIndexOf("?");
  if (t3LastQ > 0) {
    const t3Section = afterT2.slice(0, t3LastQ);
    // Decode any percent-encoded sequences in the inter-track gap, then strip
    // leading non-uppercase chars (underscores, decoded control chars, etc.).
    const t3Decoded = t3Section.replace(/%([0-9A-Fa-f]{2})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)));
    const t3 = t3Decoded.replace(/^[^A-Z]+/, "");
    if (t3.length > 0) {
      out.raw.track3 = t3;
      applyTrack3(out, t3);
    }
  }

  return out;
}
