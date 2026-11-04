// web.ts
import { WebPlugin } from "@capacitor/core";
import type { Pdf417Plugin } from "./definitions";

export class Pdf417Web extends WebPlugin implements Pdf417Plugin {
  async decodePdf417(): Promise<{ raw: string | null; format?: string }> {
    // PDF417 decoding here is native-only. (If you ever need web, wire a JS
    // PDF417 library such as zxing-wasm in this method.)
    throw this.unimplemented("PDF417 decode is native-only — run on a device.");
  }
}
