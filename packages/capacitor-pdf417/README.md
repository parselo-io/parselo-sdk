# @parselo/capacitor-pdf417

Capacitor plugin for on-device PDF417 barcode decoding. Wraps Apple Vision
(`VNDetectBarcodesRequest`) on iOS and ML Kit Barcode Scanning on Android.
Returns the raw payload string; pair with `@parselo/scanner-core` to parse
AAMVA driver's licence data.

## Platform support

| Platform | Backend | Min version |
|---|---|---|
| iOS | Vision — `VNDetectBarcodesRequest`, `.pdf417` | iOS 13 |
| Android | ML Kit Barcode Scanning, `FORMAT_PDF417` | API 21 |

## Install

```bash
npm install @parselo/capacitor-pdf417 @parselo/scanner-core
npx cap sync
```

### iOS — camera permission

Add to `ios/App/App/Info.plist`:

```xml
<key>NSCameraUsageDescription</key>
<string>Used to scan the barcode on your ID.</string>
```

CocoaPods installs the `Pdf417Plugin.m` ObjC bridge automatically. If the
plugin throws "not implemented" at runtime, verify that `pod install` ran after
`cap sync` and that `Pdf417Plugin.m` is listed in the Xcode target's Compile
Sources.

### Android

No extra configuration needed — the ML Kit dependency and permissions are
declared in the plugin's `build.gradle` and `AndroidManifest.xml`.

## API

```ts
import { Pdf417 } from "@parselo/capacitor-pdf417";

const { raw } = await Pdf417.decodePdf417({ image });
// raw: string | null
// null if no PDF417 barcode was found in the image.
```

`image` accepts a `data:` URI, `file://` URI, bare absolute path, or raw base64 string.

## Integration with scanner-core

```ts
import { Scanner } from "@parselo/scanner-core";
import { Pdf417 } from "@parselo/capacitor-pdf417";

const scanner = new Scanner({
  license: {
    token:      "…",
    bundleId:   "com.example.app",
    publicKeys: { "<kid>": "<base64-spki>" },
  },
  analytics: {
    ingestUrl: "…",
    store: { get, set },  // @capacitor/preferences works well
  },
  native: {
    captureAndDecodePdf417: async () => {
      const { raw } = await Pdf417.decodePdf417({ image: dataUrl });
      return raw;
    },
  },
});

await scanner.init();
const result = await scanner.scan();
```

See the [full integration guide](https://github.com/parselo-io/parselo-sdk/blob/main/integration-guide.md) for camera setup, error handling, and a complete working example.

## License

MIT
