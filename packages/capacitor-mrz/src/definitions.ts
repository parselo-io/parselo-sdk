// definitions.ts
// Capacitor plugin interface for native MRZ text recognition.
// The plugin recognises text in an image and returns all detected lines.
// scanner-core is responsible for locating the MRZ within those lines and
// parsing it — keeping all parsing logic cross-platform in the TS core.

export interface MrzPlugin {
  /**
   * Run on-device text recognition on an image and return all detected lines.
   * Pass the result to scanner-core's parseMrz() to locate and parse the MRZ.
   *
   * @param options.image  file path, file:// URI, data: URI, or bare base64 string
   * @returns lines  — every text line detected by Vision / ML Kit
   * @returns raw    — lines joined by "\n" (convenience for logging/debugging)
   */
  recognizeText(options: { image: string }): Promise<{ lines: string[]; raw: string }>;
}
