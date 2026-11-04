// web.ts
import { WebPlugin } from "@capacitor/core";
import type { MrzPlugin } from "./definitions";

export class MrzWeb extends WebPlugin implements MrzPlugin {
  async recognizeText(): Promise<{ lines: string[]; raw: string }> {
    throw this.unimplemented("MRZ text recognition is native-only — run on a device.");
  }
}
