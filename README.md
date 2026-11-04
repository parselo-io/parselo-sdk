# Parselo SDK

On-device Canadian ID scanning for Capacitor apps. Decodes the PDF417 barcode on
the back of Canadian driver's licences, ID cards and Ontario/Quebec health cards,
reads passport and Mexican INE machine-readable zones (MRZ), and enforces offline
licensing — no document data leaves the device.

## Packages

| Package | Purpose |
|---|---|
| [`@parselo/scanner-core`](packages/scanner-core) | AAMVA / magnetic-stripe / health card (Ontario, Quebec) / MRZ / INE parsing, offline license verification, scan analytics. No Capacitor dependency — testable in plain Node. |
| [`@parselo/capacitor-pdf417`](packages/capacitor-pdf417) | Capacitor plugin — native PDF417 decode via Apple Vision (iOS) and ML Kit (Android). |
| [`@parselo/capacitor-mrz`](packages/capacitor-mrz) | Capacitor plugin — native text recognition (Apple Vision / ML Kit) returning the OCR lines for MRZ parsing. |
| [`example-vue`](packages/example-vue) | Reference Capacitor + Vue 3 app wiring the packages together, with driver's licence / passport / INE modes. |

## Install

```bash
npm install @parselo/scanner-core @parselo/capacitor-pdf417 \
  @capacitor/camera @capacitor/preferences @capacitor/app
# Passport / INE scanning also needs:
npm install @parselo/capacitor-mrz
npx cap sync
```

The Capacitor plugins support both Swift Package Manager and CocoaPods on iOS.

## Quick start

See [integration-guide.md](integration-guide.md) for the full step-by-step guide.

```ts
import { Scanner } from "@parselo/scanner-core";
import { Pdf417 } from "@parselo/capacitor-pdf417";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Preferences } from "@capacitor/preferences";
import { App } from "@capacitor/app";

const { id: bundleId } = await App.getInfo();

const scanner = new Scanner({
  license: {
    token: "YOUR_LICENSE_KEY",
    publicKeys: { "YOUR_KID": "YOUR_PUBLIC_KEY" },
    bundleId,
  },
  analytics: {
    ingestUrl: "YOUR_INGEST_URL",
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
        quality: 100,
      });
      const { raw } = await Pdf417.decodePdf417({ image: photo.path! });
      return raw;
    },
  },
});

await scanner.init();                 // verifies license offline
const result = await scanner.scan();  // { ok, document?, error? }
```

`scan()` handles driver's licences, ID cards **and** Ontario/Quebec health cards —
the format is detected from the barcode payload. A health card scan returns
`document.documentType === "health_card"`.

**Passport / travel document, and Mexican INE** — add an MRZ capture function:

```ts
import { Mrz } from "@parselo/capacitor-mrz";

const scanner = new Scanner({
  license, analytics, native,
  mrzNative: {
    captureAndRecognizeMrz: async () => {
      const { lines } = await Mrz.recognizeText({ image: dataUrl });
      return lines;
    },
  },
});
await scanner.init();
const passport = await scanner.scanPassport();  // { ok, document?, error? }
const ine = await scanner.scanIne();            // { ok, document?, error? }
```

Get your license key at [parselo.io](https://parselo.io).

## Development

Requires Node 22+.

```bash
npm install
npm run build
npm test
```

Test fixtures are synthetic. Never commit data read from a real person's card or
document, in tests, comments or sample assets.

## License

Proprietary — UNLICENSED.
