# @parselo/scanner-core

Platform-agnostic core for the Parselo ID scanning SDK. Parses AAMVA PDF417
barcodes, magnetic-stripe tracks, Ontario and Quebec (RAMQ) health cards, ICAO
9303 MRZ from passports and travel documents, and Mexican INE (Credencial para
Votar) credentials into a unified canonical document shape. Includes offline
ES256 license enforcement and PII-free usage analytics.

No Capacitor dependency — fully testable in Node.

## What it parses

| Document type | Format | Notes |
|---|---|---|
| Canadian / US driver's licences & ID cards | PDF417 (AAMVA) | All provinces; dates normalised to ISO |
| BC / ON / AB licences (older stock) | Magnetic-stripe tracks encoded in PDF417 | Three-track `%…?` format |
| Ontario Health Card | PDF417, proprietary (`@ON HC` header) | Not AAMVA — reverse-engineered from one real card; validated on-device. BC/AB/NS health cards not yet supported. |
| Quebec Health Card (RAMQ) | PDF417, proprietary (`CNAM`/`CPRN`/… key-value lines) | Not AAMVA — reverse-engineered from one real card; validated on-device. Expiry is month-precision only (no day encoded). |
| Passports, emergency travel docs, PR cards | ICAO 9303 TD3 MRZ (2 × 44 chars) | Five check digits validated; VIZ cross-reference corrects `<` OCR corruption |
| Mexican INE (Credencial para Votar), models D–J | ICAO 9303 TD1 MRZ (3 × 30 chars) | Extraction + offline integrity only — see "INE offline integrity" below. Validated on 2 real cards on-device; models D onward carry the MRZ, models A–C predate it and are detected and rejected cleanly (`no_ine`) rather than crashing. PDF417 (proprietary/undocumented) is stubbed pending real sample payloads. |

All document types produce the same `CanonicalDocument` shape with identical field names and ISO `YYYY-MM-DD` dates.

## Install

```bash
npm install @parselo/scanner-core
```

A native capture plugin is required for on-device use:

| Use case | Plugin |
|---|---|
| Driver's licence / barcode | [`@parselo/capacitor-pdf417`](https://www.npmjs.com/package/@parselo/capacitor-pdf417) |
| Passport / travel document | [`@parselo/capacitor-mrz`](https://www.npmjs.com/package/@parselo/capacitor-mrz) |

## Scanning a driver's licence

```ts
import { Scanner, type BarcodeNative } from "@parselo/scanner-core";
import { Pdf417 } from "@parselo/capacitor-pdf417";

const native: BarcodeNative = {
  captureAndDecodePdf417: async () => {
    const { raw } = await Pdf417.decodePdf417({ image: dataUrl });
    return raw; // null if no barcode found
  },
};

const scanner = new Scanner({ license, analytics, native });
await scanner.init();

const result = await scanner.scan();
if (result.ok && result.document) {
  const { fields, jurisdiction } = result.document;
  console.log(fields.firstName?.value, fields.lastName?.value);
  console.log(fields.dateOfBirth?.value);   // "1985-03-12"
  console.log(jurisdiction);               // "CA-QC"
}
```

## Scanning a health card

Ontario and Quebec (RAMQ) health cards go through the exact same `scan()` call as
a driver's licence — there's no separate method. The format is auto-detected from
the barcode payload's signature (`@ON HC`, `CNAM`) before parsing, so the caller
doesn't need to know which one they're pointing the camera at.

```ts
const result = await scanner.scan();
if (result.ok && result.document?.documentType === "health_card") {
  const { fields, jurisdiction } = result.document;
  console.log(fields.firstName?.value, fields.lastName?.value);
  console.log(fields.dateOfBirth?.value);      // "1978-11-28"
  console.log(fields.documentNumber?.value);   // health insurance number (OHIP / RAMQ NAM)
  console.log(jurisdiction);                  // "CA-ON" or "CA-QC"
}
```

Both formats are proprietary and undocumented — there's no public spec to
implement against, unlike AAMVA. Each was reverse-engineered from a single real
card and validated against the dates/numbers printed on it; treat any field this
package doesn't explicitly document below as unverified. Two format-specific
quirks worth knowing:

- **Ontario**: `expiryDate` and `issueDate` are both populated (day precision).
- **Quebec (RAMQ)**: `expiryDate` is month-precision only (`"2026-11"`, not
  `"2026-11-DD"`) — the format simply doesn't encode a day.

BC, AB, and NS health cards are not supported yet — real sample payloads are
needed before they can be added (see the root README's roadmap).

## Scanning a passport or travel document

```ts
import { Scanner, type MrzNative } from "@parselo/scanner-core";
import { Mrz } from "@parselo/capacitor-mrz";

const mrzNative: MrzNative = {
  captureAndRecognizeMrz: async () => {
    const { lines } = await Mrz.recognizeText({ image: dataUrl });
    return lines; // string[] of OCR observations
  },
};

const scanner = new Scanner({ license, analytics, native, mrzNative });
await scanner.init();

const result = await scanner.scanPassport();
if (result.ok && result.document) {
  const { fields, jurisdiction } = result.document;
  console.log(fields.firstName?.value, fields.lastName?.value);
  console.log(fields.dateOfBirth?.value);  // "1978-11-28"
  console.log(fields.country?.value);      // "MEX" (ICAO 3-char)
  console.log(jurisdiction);              // "CA" for Canadian-issued docs
}
```

Handles standard passports (`P<`), emergency travel documents (`PU`), permanent
resident travel documents (`PR`), and foreign passports. The parser cross-references
Vision's biographical-zone OCR lines to recover names even when the OCR-B `<` fill
character is misread.

## Scanning a Mexican INE (Credencial para Votar)

```ts
import { Scanner, type MrzNative } from "@parselo/scanner-core";
import { Mrz } from "@parselo/capacitor-mrz";

const mrzNative: MrzNative = {
  captureAndRecognizeMrz: async () => {
    const { lines } = await Mrz.recognizeText({ image: dataUrl });
    return lines;
  },
};

const scanner = new Scanner({ license, analytics, native, mrzNative });
await scanner.init();

const result = await scanner.scanIne();
if (result.ok && result.document) {
  const { fields } = result.document;
  console.log(fields.firstName?.value, fields.lastName?.value); // given names, paternal surname
  console.log(fields.dateOfBirth?.value);
}
```

Reuses the same `mrzNative` capture as `scanPassport()` — INE cards from model D
onward carry a 3-line, 30-char ICAO 9303 TD1 MRZ on the back, located and
validated the same way the TD3 passport MRZ is. `parseIneMrz()` implements the
generic TD1 structure with no per-model branching, so it should apply uniformly
across models D–J; validated so far against 2 real cards on-device (see the root
README's Development notes for what that validation caught — a real MRZ sex-field
convention neither the original implementation nor any public spec we had access
to got right on the first try). Models A–C predate the MRZ and have no
on-device-extractable structured data via this path; those, and any non-INE MRZ
input, are rejected cleanly (`error: "no_ine"`) rather than producing garbage output.

**INE offline integrity — read this before using these fields in a product decision.**
`buildIneCredential()` (re-exported from this package) produces an `integrity` block:

```ts
interface IneIntegrity {
  mrzCheckDigitsValid: boolean;
  curpCheckDigitValid: boolean;
  claveElectorStructureValid: boolean;
  crossFieldConsistent: boolean;   // DOB/sex agree across every source present
  overall: "consistent" | "inconsistent" | "insufficient_data";
}
```

This proves internal consistency only — check digits, structural shape, and
agreement between the MRZ, CURP, and Clave de Elector when more than one is
present. **It does not prove the card is genuine, current, or registered with
INE.** Only INE's own (off-device, consent-gated) Lista Nominal verification
service can do that, and this SDK deliberately does not call it — see the root
README for why. Never surface `overall === "consistent"` to an end user as
"verified" or "valid credential".

The MRZ alone does not carry a CURP or Clave de Elector (INE's PDF417 might, but
its encoding is proprietary/undocumented and is currently stubbed — see `ine.ts`).
Until that's implemented from real sample payloads, `curp` and `claveElector` are
only populated if you pass them into `buildIneCredential()` yourself from another
source, and `integrity.overall` correctly reports `"insufficient_data"` when no
identifiers besides the MRZ were available to cross-check.

## Canonical document shape

```ts
interface CanonicalDocument {
  documentType: "drivers_license" | "id_card" | "health_card" | "passport" | "ine" | "unknown";
  jurisdiction: string;   // "CA-QC", "CA-BC", "CA", "MEX", "MX", …
  fields: {
    // All document types
    firstName?:         Field;
    lastName?:          Field;
    middleName?:        Field;
    dateOfBirth?:       Field;  // ISO YYYY-MM-DD
    expiryDate?:        Field;  // ISO YYYY-MM-DD
    documentNumber?:    Field;
    sex?:               Field;
    // Driver's licences
    addressStreet?:     Field;
    addressCity?:       Field;
    addressRegion?:     Field;
    addressPostalCode?: Field;
    vehicleClass?:      Field;
    // Passports / travel documents / INE
    country?:           Field;  // ICAO 3-char issuing country, "MEX" for INE
  };
  raw?: Record<string, string>;   // INE also carries raw.curp / raw.claveElector when present
}
```

Mexican naming has two surnames with no dedicated canonical slot: INE maps
`lastName` to the paternal surname and `middleName` to the maternal surname
(same "reuse the generic shape" approach every document type here takes).

```ts
interface Field {
  value:      string;
  confidence: number;               // 0–1
  source:     "barcode" | "mrz";
}
```

## Scan result

```ts
interface ScanResult {
  ok:        boolean;
  document?: CanonicalDocument;
  error?:    ScanError;
}

type ScanError =
  | "no_barcode" | "not_aamva"        // barcode path
  | "no_mrz"                          // passport path
  | "no_ine"                          // INE path
  | "license_expired" | "license_bundle_mismatch"
  | "license_bad_signature" | "license_unknown_key" | "license_malformed";
```

## License enforcement

Tokens are ES256 JWTs signed by AWS KMS. `scanner.init()` verifies the
signature offline against the embedded public key — no network call required.
Each token encodes an expiry date, an allowed bundle ID list, and a scan quota.

```ts
const { valid, reason, claims } = await scanner.init();
if (!valid) {
  // reason: "expired" | "bundle_mismatch" | "bad_signature"
  //       | "unknown_key" | "malformed"
}
```

## Analytics

One PII-free event per scan (document type, jurisdiction, success/fail,
confidence bucket, device model — never document field values). Events buffer
locally and flush in batches. Force a flush with:

```ts
await scanner.flushAnalytics();
```

## Design notes

- **Every parser file (`aamva.ts`, `magstripe.ts`, `ontario-hc.ts`, `quebec-hc.ts`,
  `mrz.ts`, `ine.ts`) is fully self-contained** — none of them import from each
  other at the value level,
  even where the logic genuinely overlaps (`ine.ts` has its own internal copy
  of the ICAO 7-3-1 check-digit algorithm and 2-digit-year resolution that
  `mrz.ts` also implements). This is deliberate, not an oversight: `src/test.ts`
  runs every parser directly through Node's ESM loader
  (`node --experimental-strip-types`), which requires exact-extension relative
  specifiers (`./mrz.ts`); the real `tsc` build targets bundler-style module
  resolution and expects extension-less specifiers (`./mrz`) for downstream
  Vite/Capacitor consumers. A single cross-file import statement can't satisfy
  both resolution modes, so `ine.ts` duplicates the ~20 lines of shared
  algorithm rather than importing them — consistent with how every other
  parser file in this package was already structured before INE existed.
- **`ine.ts` implements the generic ICAO 9303 TD1 structure, not a per-model
  INE format.** There's no model-letter detection or branching anywhere in it.
  INE cards from model D onward all carry a standard TD1 MRZ; models A–C
  predate it and simply have nothing for this path to extract. This has been
  validated on 2 real cards (see root README's Development notes for a bug
  that validation caught: INE's MRZ sex field is the literal Spanish `H`/`M`
  character, not an ICAO M/F code needing translation — an assumption that
  looked reasonable by analogy to the TD3 passport parser and was wrong).

## License

MIT
