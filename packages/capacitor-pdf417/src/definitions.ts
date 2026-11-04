// definitions.ts
// Capacitor plugin interface for native PDF417 decoding.
// Decode-only by design: text-detect owns the camera and hands off a captured
// frame; this returns the raw AAMVA payload untouched for scanner-core to parse.

export interface Pdf417Plugin {
  /**
   * Decode a PDF417 barcode from an image.
   * @param options.image  a file path, file:// URI, data: URI, or bare base64 string
   * @returns raw payload string (control characters preserved) or null if none found
   */
  decodePdf417(options: { image: string }): Promise<{ raw: string | null; format?: string }>;
}
