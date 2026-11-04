# Parselo — Quickstart

Scan Canadian driver's licences and ID cards in your Capacitor app. The SDK decodes
the PDF417 barcode on the back of the card **on-device** and returns the parsed fields
(name, date of birth, document number, address, expiry). No document data leaves the
device, and it works offline.

This takes about five minutes. Any Capacitor app works — Vue, React, Angular, or
vanilla.

## Before you start

You'll need:

- A **Capacitor app** targeting iOS and/or Android.
- Your **integration config** from the dashboard — a license key, a public key, and an
  analytics endpoint. The dashboard's *Integration* panel gives you a ready-to-paste
  block with all three filled in.
- Your app's **bundle id** (iOS bundle identifier / Android `applicationId`). Your key
  is bound to it — enter it when you request the key.

## 1. Install

```bash
npm install @parselo/scanner-core @parselo/capacitor-pdf417 @parselo/capacitor-mrz \
  @capacitor/camera @capacitor/preferences @capacitor/app
npx cap sync
```

What each package is for: `scanner-core` (parsing + licensing), `capacitor-pdf417`
(native barcode decode), `capacitor-mrz` (native MRZ text recognition),
`@capacitor/camera` (capture), `@capacitor/preferences` (offline analytics buffer),
`@capacitor/app` (reads your bundle id at runtime).
`npx cap sync` compiles the native plugins into your iOS and Android projects.

If you only need driver's licence scanning and not passport, you can omit
`@parselo/capacitor-mrz` — the barcode path is independent.

## 2. Add camera permission

- **iOS** — add to `ios/App/App/Info.plist`:
  ```xml
  <key>NSCameraUsageDescription</key>
  <string>Used to scan the barcode on your ID.</string>
  ```
- **Android** — the camera permission is included by the plugin; nothing to add for a
  standard setup.

## 3. Create the scanner

Paste the `token`, `publicKeys`, and `ingestUrl` from your dashboard's *Integration*
panel into the marked spots. Everything else is ready as-is.

```ts
import { Scanner } from "@parselo/scanner-core";
import { Pdf417 } from "@parselo/capacitor-pdf417";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Preferences } from "@capacitor/preferences";
import { App } from "@capacitor/app";

export async function createScanner() {
  const { id: bundleId } = await App.getInfo();   // your app's real bundle id

  return new Scanner({
    license: {
      // — paste from your dashboard ———————————————————————————————————————
      token: "{{LICENSE_KEY}}",
      publicKeys: { "{{KID}}": "{{PUBLIC_KEY}}" },
      // ——————————————————————————————————————————————————————————————————
      bundleId,                       // must match the key's bundle id
    },
    analytics: {
      ingestUrl: "{{INGEST_URL}}",   // from your dashboard
      store: {
        get: async (k) => (await Preferences.get({ key: k })).value,
        set: async (k, v) => { await Preferences.set({ key: k, value: v }); },
      },
    },
    native: {
      captureAndDecodePdf417: async () => {
        const photo = await Camera.getPhoto({
          resultType: CameraResultType.Uri,
          source: CameraSource.Camera,
          quality: 100,               // PDF417 is dense — keep the photo sharp
        });
        const { raw } = await Pdf417.decodePdf417({ image: photo.path! });
        return raw;                   // null if no barcode was found
      },
    },
  });
}
```

The `token` is yours; `publicKeys` and `ingestUrl` are the same for every customer
(they point at Parselo's verification key and analytics endpoint).

## 4. Verify the licence, then scan

### Driver's licence / ID card

```ts
const scanner = await createScanner();

const license = await scanner.init();    // verifies your key offline, once
if (!license.valid) {
  // license.reason: "expired" | "bundle_mismatch" | "bad_signature"
  //               | "unknown_key" | "malformed"
  console.error("Licence not valid:", license.reason);
  return;
}

const result = await scanner.scan();      // opens the camera, decodes, parses
if (result.ok && result.document) {
  const f = result.document.fields;
  console.log("Name:", f.firstName?.value, f.lastName?.value);
  console.log("DOB:", f.dateOfBirth?.value);          // YYYY-MM-DD
  console.log("Doc #:", f.documentNumber?.value);
  console.log("Expires:", f.expiryDate?.value);       // YYYY-MM-DD
  console.log("Jurisdiction:", result.document.jurisdiction);  // e.g. "CA-QC"
} else {
  // result.error: "no_barcode" | "not_aamva" | "license_expired"
  //             | "license_bundle_mismatch" | "license_bad_signature"
  //             | "license_unknown_key" | "license_malformed"
  console.warn("Scan failed:", result.error);
}
```

That's the barcode integration. `init()` once, then `scan()` whenever you need a scan.

### Health card (Ontario / Quebec)

No extra setup or separate method needed — Ontario and Quebec (RAMQ) health cards
go through the exact same `scan()` call as a driver's licence. The SDK detects the
format automatically from the barcode payload and returns
`document.documentType === "health_card"`:

```ts
const result = await scanner.scan();      // same call as the driver's licence path
if (result.ok && result.document?.documentType === "health_card") {
  const f = result.document.fields;
  console.log("Name:", f.firstName?.value, f.lastName?.value);
  console.log("DOB:", f.dateOfBirth?.value);
  console.log("Health number:", f.documentNumber?.value);  // OHIP number or RAMQ NAM
  console.log("Jurisdiction:", result.document.jurisdiction);  // "CA-ON" or "CA-QC"
}
```

Two things worth knowing before you rely on these fields:

- Both formats are proprietary and undocumented (unlike AAMVA) — each was
  reverse-engineered from a single real card, so treat any field not covered
  here as unverified.
- Quebec's `expiryDate` is **month-precision only** (e.g. `"2026-11"`) — the
  card's barcode simply doesn't encode a day.

BC, AB, and NS health cards aren't supported yet.

### Passport / travel document (MRZ)

Add `@parselo/capacitor-mrz` to your scanner config to unlock passport scanning.
The same `Scanner` instance handles both document types — only the method you
call changes.

```ts
import { Mrz } from "@parselo/capacitor-mrz";

// Add mrzNative alongside native when constructing the scanner:
return new Scanner({
  license: { … },
  analytics: { … },
  native: { captureAndDecodePdf417: … },   // barcode path unchanged
  mrzNative: {
    captureAndRecognizeMrz: async () => {
      // Capture a full camera frame and pass it to the MRZ plugin.
      // The plugin runs Vision / ML Kit on the entire image and returns
      // every recognised text observation as an array of strings.
      const { lines } = await Mrz.recognizeText({ image: dataUrl });
      return lines;
    },
  },
});
```

Then call `scanPassport()` instead of `scan()`:

```ts
const result = await scanner.scanPassport();
if (result.ok && result.document) {
  const f = result.document.fields;
  console.log("Name:", f.firstName?.value, f.lastName?.value);
  console.log("DOB:", f.dateOfBirth?.value);           // YYYY-MM-DD
  console.log("Expiry:", f.expiryDate?.value);         // YYYY-MM-DD
  console.log("Country:", f.country?.value);           // ICAO 3-char, e.g. "CAN", "MEX"
  console.log("Jurisdiction:", result.document.jurisdiction);  // e.g. "CA", "MEX"
} else {
  // result.error: "no_mrz" if no valid MRZ was found
}
```

**Supported document types:** standard passports (`P`), emergency travel documents
(`PU`), permanent resident travel documents (`PR`), and foreign passports of any
country.

**How name extraction works:** The OCR-B MRZ font uses `<` as a word separator,
which Vision and ML Kit frequently misread as `C`, `S`, `K`, etc. The SDK
automatically cross-references Vision's biographical-zone lines (the human-readable
area above the MRZ) to recover the correct first and last names, even when the
MRZ separator characters are corrupted.

**Camera UI:** Point the camera at the full data page of the passport (the page
with the photo). The MRZ zone — two rows of monospace characters — is at the
bottom. Hold the document flat, well-lit, and filling the frame. The SDK samples
frames at 800 ms intervals and pre-validates each frame before accepting it, so
brief focus wobble doesn't produce a false result.

## What you get back

`scan()` resolves to `{ ok, document?, error? }`. On success, `document` is a
`CanonicalDocument`:

| Property | Description |
|---|---|
| `documentType` | `"drivers_license"`, `"id_card"`, `"health_card"`, `"passport"`, `"ine"`, or `"unknown"` |
| `jurisdiction` | Issuing place, e.g. `"CA-QC"`, `"CA-ON"` |
| `fields` | The parsed fields (below). Each is `{ value, confidence, source }` |
| `raw` | Every raw AAMVA element by 3-letter code, for advanced use |

Available `fields` (each optional, present when the card carries it): `firstName`,
`lastName`, `middleName`, `dateOfBirth`, `expiryDate`, `issueDate`, `documentNumber`,
`sex`, `addressStreet`, `addressCity`, `addressRegion`, `addressPostalCode`, `country`,
`vehicleClass`.

Notes: dates are ISO `YYYY-MM-DD`. `confidence` is ~1.0 for barcode data (it's
error-corrected, so it's exact, not a guess). `source` is `"barcode"`.

## Usage analytics

The SDK records one **PII-free** event per scan — counts and metadata only, never
document data — buffers them locally, and flushes in batches. They power the usage view
in your dashboard. To push promptly (e.g. when the app goes to the background), call:

```ts
await scanner.flushAnalytics();
```

Because events buffer offline and sync when there's a connection, dashboard usage can
lag slightly behind the device.

## The one thing to get right: the bundle id

Your key is bound to your app's bundle id. The SDK reads the **running app's** bundle id
at runtime (`App.getInfo().id`), so the only way to hit `bundle_mismatch` is if the key
was issued for a *different* id than the app you're running. If that happens, check that
the bundle id you entered in the dashboard matches your app exactly. Shipping more than
one app? Add each bundle id in the dashboard and you'll get a key valid for all of them.

## Test on a real device

A simulator or emulator has no camera and can't scan a physical card — **test on real
hardware.** Photograph the **back** of the licence (the PDF417 barcode, not the photo
side), held flat, well-lit, and filling the frame. Almost every decode failure on a
genuine card is photo quality, not the card.

## Troubleshooting

| You see | Why | Fix |
|---|---|---|
| `init()` → `bundle_mismatch` | App's bundle id isn't on the key | Match the bundle id, or add it in the dashboard |
| `init()` → `expired` | Trial or key has expired | Issue a fresh key in the dashboard, or upgrade |
| `init()` → `bad_signature` / `unknown_key` | `token`/`publicKeys` don't match | Re-copy the config block from the dashboard |
| `scan()` → `no_barcode` | No PDF417 found in the photo | Shoot the **back** of the card, sharper / flatter / closer |
| `scan()` → `not_aamva` | A barcode was read, but it isn't an ID | Scan a Canadian/US driver's licence or ID card |
| `scanPassport()` → `no_mrz` | No valid MRZ found after camera session | Point at the **data page** (photo side), well-lit, flat, not at an angle |
| MRZ plugin unrecognised (no Xcode logs) | ObjC bridge file missing from build target | Verify `MrzPlugin.m` (or `Pdf417Plugin.m`) is in Xcode Compile Sources; re-run `pod install` |
| Names show garbled characters on passport | MRZ `<` fill chars misread by OCR | Usually self-corrects via VIZ cross-reference; if persistent, re-scan with better lighting |
| `recognizeText` / `decodePdf417` throws "native-only" | Running in a browser | Both plugins are native-only — run on a real device |
| Plugin not found after install | Native projects not synced | Re-run `npx cap sync` then rebuild in Xcode / Android Studio |

## Going to production

When your trial ends, upgrade in the dashboard and you'll get a production key — just
swap the `token`, the code is identical. Add more bundle ids for additional apps;
billing is based on total scan volume across them.

## Privacy

Parsing happens entirely on the device, and the analytics this SDK sends contain only
counts and metadata — never names, dates of birth, document numbers, or addresses. That
keeps document data off the wire and supports your PIPEDA / Law 25 posture.
