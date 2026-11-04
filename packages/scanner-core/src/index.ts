// index.ts
// Ties the core together and shows the wrap points explicitly:
//   verify license (gate)  ->  native capture  ->  parse  ->  canonical  ->  emit analytics
//
// Supports two scan paths:
//   scan()         — PDF417 barcode (driver's licences)
//   scanPassport() — MRZ text recognition (passports)

import { parseAamva } from "./aamva";
import { parseMagstripe } from "./magstripe";
import { parseMrz } from "./mrz";
import { parseIneMrz, buildIneCredential } from "./ine";
import { parseOntarioHc } from "./ontario-hc";
import { parseQuebecHc } from "./quebec-hc";
import { toCanonical, magstripeToCanonical, mrzToCanonical, ineToCanonical, ontarioHcToCanonical, quebecHcToCanonical, type CanonicalDocument } from "./canonical";
import type { FieldSource } from "./canonical";
import { verifyLicense, isExpired, type LicenseResult, type LicenseClaims } from "./license";
import { ScanAnalytics, type AnalyticsConfig, type ScanEvent } from "./analytics";

export * from "./aamva";
export * from "./magstripe";
export * from "./mrz";
export * from "./ine";
export * from "./ontario-hc";
export * from "./quebec-hc";
export * from "./canonical";
export * from "./license";
export * from "./analytics";

// Implemented natively: capture a frame and return the raw PDF417 payload, or null.
export interface BarcodeNative {
  captureAndDecodePdf417(): Promise<string | null>;
}

// Implemented natively: run text recognition on a passport photo page and return
// all recognised lines, or null if nothing was detected.
export interface MrzNative {
  captureAndRecognizeMrz(): Promise<string[] | null>;
}

export interface ScannerConfig {
  license: {
    token: string;
    bundleId: string;                    // from native (Capacitor App.getInfo().id)
    publicKeys: Record<string, string>;  // kid -> base64 SPKI, embedded in the plugin
  };
  analytics: AnalyticsConfig;
  native: BarcodeNative;
  mrzNative?: MrzNative;               // required only for scanPassport()
  deviceModel: string;                 // e.g. "Apple iPhone" | "Samsung SM-G991B"
}

export type ScanError =
  | "license_malformed" | "license_unknown_key" | "license_bad_signature"
  | "license_expired" | "license_bundle_mismatch"
  | "no_barcode" | "not_aamva"
  | "no_mrz"
  | "no_ine";

export interface ScanResult {
  ok: boolean;
  document?: CanonicalDocument;
  error?: ScanError;
}

export class Scanner {
  private readonly cfg: ScannerConfig;
  private readonly analytics: ScanAnalytics;
  private claims?: LicenseClaims;

  constructor(cfg: ScannerConfig) {
    this.cfg = cfg;
    this.analytics = new ScanAnalytics(cfg.analytics);
  }

  /** Verify the signature once, up front. Call on plugin init. */
  async init(): Promise<LicenseResult> {
    const result = await verifyLicense({
      token: this.cfg.license.token,
      bundleId: this.cfg.license.bundleId,
      publicKeys: this.cfg.license.publicKeys,
    });
    if (result.valid) this.claims = result.claims;
    return result;
  }

  /** Scan a driver's licence or provincial ID card via PDF417 barcode. */
  async scan(): Promise<ScanResult> {
    // (1) LICENSE GATE -----------------------------------------------------
    const licenseError = await this.checkLicense();
    if (licenseError) return { ok: false, error: licenseError };

    // (2) NATIVE DECODE ----------------------------------------------------
    const raw = await this.cfg.native.captureAndDecodePdf417();
    if (!raw) {
      await this.emit("unknown", "", false, "low");
      return { ok: false, error: "no_barcode" };
    }

    // (3) PARSE — route to the correct parser based on format signature ------
    const trimmedRaw = raw.replace(/^[\x00-\x1f\s]+/, "");
    let document: CanonicalDocument;

    if (trimmedRaw.startsWith("@ON HC")) {
      const ohc = parseOntarioHc(trimmedRaw);
      if (!ohc.isOntarioHc) {
        await this.emit("unknown", "", false, "low");
        return { ok: false, error: "not_aamva" };
      }
      document = ontarioHcToCanonical(ohc);
    } else if (trimmedRaw.startsWith("CNAM")) {
      const qhc = parseQuebecHc(trimmedRaw);
      if (!qhc.isQuebecHc) {
        await this.emit("unknown", "", false, "low");
        return { ok: false, error: "not_aamva" };
      }
      document = quebecHcToCanonical(qhc);
    } else if (trimmedRaw.startsWith("@") || raw.includes("ANSI ")) {
      const aamva = parseAamva(raw);
      if (!aamva.isAamva) {
        await this.emit("unknown", "", false, "low");
        return { ok: false, error: "not_aamva" };
      }
      document = toCanonical(aamva);
    } else if (trimmedRaw.startsWith("%")) {
      const ms = parseMagstripe(raw);
      if (!ms.isMagstripe) {
        await this.emit("unknown", "", false, "low");
        return { ok: false, error: "not_aamva" };
      }
      document = magstripeToCanonical(ms);
    } else {
      await this.emit("unknown", "", false, "low");
      return { ok: false, error: "not_aamva" };
    }

    // (4) ANALYTICS (PII-FREE) --------------------------------------------
    await this.emit(document.documentType, document.jurisdiction, true, "high");

    // (5) RETURN -----------------------------------------------------------
    return { ok: true, document };
  }

  /** Scan a passport via on-device MRZ text recognition. */
  async scanPassport(): Promise<ScanResult> {
    // (1) LICENSE GATE -----------------------------------------------------
    const licenseError = await this.checkLicense();
    if (licenseError) return { ok: false, error: licenseError };

    // (2) NATIVE TEXT RECOGNITION ------------------------------------------
    if (!this.cfg.mrzNative) return { ok: false, error: "no_mrz" };
    const lines = await this.cfg.mrzNative.captureAndRecognizeMrz();
    if (!lines || lines.length === 0) {
      await this.emit("unknown", "", false, "low", "mrz");
      return { ok: false, error: "no_mrz" };
    }

    // (3) PARSE ------------------------------------------------------------
    const mrz = parseMrz(lines);
    if (!mrz.isMrz || mrz.confidence === 0) {
      await this.emit("unknown", "", false, "low", "mrz");
      return { ok: false, error: "no_mrz" };
    }

    // (4) CANONICAL --------------------------------------------------------
    const document = mrzToCanonical(mrz);

    // (5) ANALYTICS (PII-FREE) --------------------------------------------
    const bucket: ScanEvent["confidenceBucket"] =
      mrz.confidence >= 0.8 ? "high" : mrz.confidence >= 0.6 ? "medium" : "low";
    await this.emit(document.documentType, document.jurisdiction, true, bucket, "mrz");

    // (6) RETURN -----------------------------------------------------------
    return { ok: true, document };
  }

  /**
   * Scan a Mexican INE (Credencial para Votar) via on-device MRZ text
   * recognition. Reuses the same mrzNative capture used by scanPassport() —
   * no new native path required, since native code only does OCR and all
   * parsing stays in this package.
   *
   * This produces extraction + offline integrity signals only. It does NOT
   * verify the credential against INE's Lista Nominal registry — that is an
   * off-device, consent-gated service and is explicitly out of scope (see
   * README). Do not present `document`'s presence as proof of authenticity.
   */
  async scanIne(): Promise<ScanResult> {
    // (1) LICENSE GATE -----------------------------------------------------
    const licenseError = await this.checkLicense();
    if (licenseError) return { ok: false, error: licenseError };

    // (2) NATIVE TEXT RECOGNITION ------------------------------------------
    if (!this.cfg.mrzNative) return { ok: false, error: "no_ine" };
    const lines = await this.cfg.mrzNative.captureAndRecognizeMrz();
    if (!lines || lines.length === 0) {
      await this.emit("unknown", "", false, "low", "mrz");
      return { ok: false, error: "no_ine" };
    }

    // (3) PARSE — TD1 MRZ only today; PDF417 is stubbed (see ine.ts) -------
    const mrz = parseIneMrz(lines);
    if (!mrz.isIne || mrz.confidence === 0) {
      await this.emit("unknown", "", false, "low", "mrz");
      return { ok: false, error: "no_ine" };
    }

    // (4) CREDENTIAL + CANONICAL ---------------------------------------------
    const credential = buildIneCredential({ mrz, source: "MRZ" });
    const document = ineToCanonical(credential);

    // (5) ANALYTICS (PII-FREE) --------------------------------------------
    const bucket: ScanEvent["confidenceBucket"] =
      mrz.confidence >= 0.8 ? "high" : mrz.confidence >= 0.6 ? "medium" : "low";
    await this.emit(document.documentType, document.jurisdiction, true, bucket, "mrz");

    // (6) RETURN -----------------------------------------------------------
    return { ok: true, document };
  }

  /** Flush buffered analytics (e.g. on app foreground/background). */
  async flushAnalytics(): Promise<void> {
    await this.analytics.flush();
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async checkLicense(): Promise<ScanError | null> {
    if (!this.claims) {
      const result = await this.init();
      if (!result.valid) return `license_${result.reason}` as ScanError;
    }
    // Cheap per-scan expiry re-check (no crypto) so a long session can't outlive the token.
    if (!this.claims || isExpired(this.claims)) return "license_expired";
    return null;
  }

  private async emit(
    documentType: string,
    jurisdiction: string,
    success: boolean,
    confidenceBucket: ScanEvent["confidenceBucket"],
    source: FieldSource = "barcode",
  ): Promise<void> {
    await this.analytics.record({
      jti: this.claims?.jti ?? "unknown",
      ts: new Date().toISOString(),
      documentType,
      jurisdiction,
      source,
      success,
      confidenceBucket,
      deviceModel: this.cfg.deviceModel,
    });
  }
}
