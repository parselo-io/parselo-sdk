# @parselo/capacitor-mrz

Capacitor plugin for on-device MRZ (Machine Readable Zone) text recognition.
Wraps Apple Vision (`VNRecognizeTextRequest`) on iOS and ML Kit Text Recognition
on Android. Returns the recognised text lines; pair with `@parselo/scanner-core`
to locate, parse, and validate the ICAO 9303 MRZ.

Supports all ICAO TD3 travel document types: standard passports (`P<`),
emergency travel documents (`PU`), permanent resident travel documents (`PR`),
and foreign passports. Also supports the ICAO TD1 MRZ carried on Mexican INE
(Credencial para Votar) cards, models D–J — same OCR capture, `scanner-core`
locates the 3×30-char triplet instead of the 2×44-char passport pair. Validated
on 2 real INE cards on-device (iOS).

## Platform support

| Platform | Backend | Min version |
|---|---|---|
| iOS | Vision — `VNRecognizeTextRequest`, `.accurate` level | iOS 13 |
| Android | ML Kit Text Recognition v2, Latin script | API 21 |

Language correction is disabled on both platforms — it would corrupt MRZ
tokens and check digits.

## Install

```bash
npm install @parselo/capacitor-mrz @parselo/scanner-core
npx cap sync
```

### iOS — camera permission

Add to `ios/App/App/Info.plist` (if not already present):

```xml
<key>NSCameraUsageDescription</key>
<string>Used to scan the MRZ on your travel document.</string>
```

Both iOS package managers are supported:

- **Swift Package Manager** (Capacitor 8, iOS 15+) — the package root ships a
  `Package.swift`; `npx cap sync` adds it to your app's `CapApp-SPM` package.
- **CocoaPods** (Capacitor 6–8) — `npx cap sync` runs `pod install` with
  `ParseloCapacitorMrz.podspec`.

If the plugin throws "not implemented" at runtime, re-run `npx cap sync ios`
and check that `MrzPlugin` appears in `packageClassList` in
`ios/App/App/capacitor.config.json`.

### Android

No extra configuration needed — the ML Kit dependency is declared in the
plugin's `build.gradle`.

## API

```ts
import { Mrz } from "@parselo/capacitor-mrz";

const { lines, raw } = await Mrz.recognizeText({ image });
// lines: string[]  — one element per Vision/ML Kit text observation
// raw:   string    — lines joined with "\n"
```

`image` accepts a `data:` URI, `file://` URI, bare absolute path, or raw base64 string.

Pass the full camera frame — the plugin sends the entire image to the OCR
engine. `scanner-core` locates the MRZ lines anywhere in the returned array
(two 44-char lines for passports via `scanPassport()`, three 30-char lines
for INE via `scanIne()`) and handles OCR noise in the surrounding text.

## Integration with scanner-core

```ts
import { Scanner } from "@parselo/scanner-core";
import { Mrz }     from "@parselo/capacitor-mrz";

const scanner = new Scanner({
  license: {
    token:      "…",
    bundleId:   "com.example.app",
    publicKeys: { "<kid>": "<base64-spki>" },
  },
  analytics: {
    ingestUrl: "…",
    store: { get, set },
  },
  native:    { captureAndDecodePdf417: … },  // still needed for barcode scanning
  mrzNative: {
    captureAndRecognizeMrz: async () => {
      const { lines } = await Mrz.recognizeText({ image: dataUrl });
      return lines;
    },
  },
});

await scanner.init();
const result = await scanner.scanPassport();
// result.document.documentType === "passport"
// result.document.fields.firstName.value, .dateOfBirth.value, .country.value, …
```

### How name extraction works

OCR-B MRZ uses `<` as a word separator, which Vision and ML Kit frequently
misread as `C`, `S`, `K`, `@`, etc. `scanner-core` automatically cross-references
Vision's biographical-zone lines (the human-readable area above the MRZ, read
in a standard font) to recover correct first and last names even when the MRZ
separator characters are corrupted.

See the [full integration guide](https://github.com/parselo-io/parselo-sdk/blob/main/integration-guide.md) for a complete setup walkthrough including the camera UI component.

## License

MIT
