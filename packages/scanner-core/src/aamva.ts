// aamva.ts
// Zero-dependency AAMVA PDF417 payload parser (US + Canada, CDS versions 1-12).
//
// The barcode is DECODED natively (ML Kit on Android, Vision on iOS); the raw
// payload string is passed across the bridge and parsed here, so parsing is
// identical on every platform and there is one place to fix bugs.

export interface AamvaHeader {
  fileType: string;            // "ANSI" (post-2000) or "AAMVA" (pre-2000)
  iin: string;                 // 6-digit Issuer Identification Number
  aamvaVersion: string;        // 2-digit AAMVA CDS version
  jurisdictionVersion?: string;
}

export interface AamvaResult {
  isAamva: boolean;
  header?: AamvaHeader;
  subfileTypes: string[];               // e.g. ["DL"] or ["ID"]
  elements: Record<string, string>;     // 3-letter code -> value (dates normalised to ISO)
}

const DATE_CODES = new Set(["DBA", "DBB", "DBD", "DDB"]);

// Codes we recognise for the regex fallback path (used only if the subfile
// directory is unparseable on an oddly-encoded card).
const KNOWN_CODES = [
  "DCA", "DCB", "DCD", "DBA", "DCS", "DAC", "DAD", "DBD", "DBB", "DBC", "DAY",
  "DAU", "DAG", "DAH", "DAI", "DAJ", "DAK", "DAQ", "DCF", "DCG", "DCK", "DDA",
  "DDB", "DAZ", "DAW", "DCL", "DDE", "DDF", "DDG", "DDH", "DDI", "DDJ", "DDK",
  "DDL", "DAR", "DAS", "DAT", "DCH", "DBN", "DBG", "DBS", "DCU", "DCE", "DDC",
  "DDD", "DAA", "DAB", "DAE",
];

// AAMVA dates: CCYYMMDD in Canada, MMDDCCYY in the US. We pre-detect the
// country from DCG; a year-first prefix (19xx/20xx) is the tie-breaker.
function normaliseDate(value: string, country: string): string {
  const v = value.trim();
  if (v.length !== 8 || !/^\d{8}$/.test(v)) return value;
  let ccyy: string, mm: string, dd: string;
  if (country === "CAN" || v.slice(0, 2) === "19" || v.slice(0, 2) === "20") {
    ccyy = v.slice(0, 4); mm = v.slice(4, 6); dd = v.slice(6, 8); // CCYYMMDD
  } else {
    mm = v.slice(0, 2); dd = v.slice(2, 4); ccyy = v.slice(4, 8); // MMDDCCYY
  }
  return `${ccyy}-${mm}-${dd}`;
}

export function parseAamva(raw: string): AamvaResult {
  const result: AamvaResult = { isAamva: false, subfileTypes: [], elements: {} };
  if (!raw.startsWith("@")) return result;

  let markerPos = -1;
  let marker: string | null = null;
  for (const m of ["ANSI ", "AAMVA"]) {
    const idx = raw.indexOf(m);
    if (idx !== -1) { markerPos = idx; marker = m; break; }
  }
  if (marker === null) return result;
  result.isAamva = true;

  let j = markerPos + marker.length;
  const iin = raw.slice(j, j + 6); j += 6;
  const aamvaVersion = raw.slice(j, j + 2); j += 2;
  const ver = parseInt(aamvaVersion, 10);
  let jurisdictionVersion: string | undefined;
  if (!Number.isNaN(ver) && ver >= 2) { jurisdictionVersion = raw.slice(j, j + 2); j += 2; }
  const entriesStr = raw.slice(j, j + 2); j += 2;
  const n = parseInt(entriesStr, 10);

  result.header = {
    fileType: marker.trim(),
    iin,
    aamvaVersion,
    ...(jurisdictionVersion ? { jurisdictionVersion } : {}),
  };

  // Country first (it drives the date format). DCG can sit anywhere in the body.
  let country = "";
  const dcgIdx = raw.indexOf("DCG");
  if (dcgIdx !== -1) {
    country = raw.slice(dcgIdx + 3).replace(/\r/g, "\n").split("\n")[0].trim().slice(0, 3);
  }

  const store = (code: string, value: string) => {
    if (!/^[A-Z]{3}$/.test(code)) return;
    result.elements[code] = DATE_CODES.has(code) ? normaliseDate(value, country) : value;
  };

  // Primary path: walk the subfile directory. Offsets are counted from byte 0
  // (the "@"), and since we decode bytes 1:1, character offsets == byte offsets.
  let k = j;
  const directory: Array<{ type: string; off: number; len: number }> = [];
  const entryCount = Number.isNaN(n) ? 0 : n;
  for (let i = 0; i < entryCount; i++) {
    if (k + 10 > raw.length) break;
    const type = raw.slice(k, k + 2);
    const offStr = raw.slice(k + 2, k + 6);
    const lenStr = raw.slice(k + 6, k + 10);
    k += 10;
    if (/^\d{4}$/.test(offStr) && /^\d{4}$/.test(lenStr)) {
      directory.push({ type, off: parseInt(offStr, 10), len: parseInt(lenStr, 10) });
    }
  }

  let parsedAny = false;
  for (const { type, off, len } of directory) {
    result.subfileTypes.push(type);
    const seg = raw.slice(off, off + len);
    const body = seg.slice(0, 2) === type ? seg.slice(2) : seg; // strip repeated subfile designator
    for (const elem of body.replace(/\r/g, "\n").split("\n")) {
      if (elem.length < 3) continue;
      const code = elem.slice(0, 3);
      if (/^[A-Z]{3}$/.test(code)) { store(code, elem.slice(3)); parsedAny = true; }
    }
  }

  // Fallback: regex scan for known codes if directory parsing yielded nothing.
  if (!parsedAny) {
    const re = new RegExp(`(${KNOWN_CODES.join("|")})([^\\n\\r]*)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) store(m[1], m[2]);
  }

  return result;
}
