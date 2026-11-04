// license.ts
// Verifies a KMS-signed license token entirely on-device, with no network call.
// The token is a compact JWS (ES256 / NIST P-256): base64url(header).base64url(payload).base64url(signature)
// The plugin embeds only the PUBLIC key (SPKI), so trials can expire offline.

export interface LicenseClaims {
  sub: string;          // customer id
  plan: string;         // e.g. "trial" | "pro"
  quota?: number;       // informational on-device; the server is the billing source of truth
  iat: number;          // issued-at (unix seconds)
  exp: number;          // expiry (unix seconds)
  bundleIds: string[];  // app bundle ids this token is valid for
  jti: string;          // license id (also the analytics key)
  kid: string;          // which embedded public key verifies this token
}

export interface LicenseResult {
  valid: boolean;
  reason?: "malformed" | "unknown_key" | "bad_signature" | "expired" | "bundle_mismatch";
  claims?: LicenseClaims;
}

export interface VerifyOptions {
  token: string;
  bundleId: string;                       // the running app's id (from native)
  publicKeys: Record<string, string>;     // kid -> base64 SPKI (DER) of the public key
  now?: number;                           // override for testing (unix seconds)
}

// --- base64 / base64url helpers (work in the webview and in Node) ---
// Return types below are intentionally inferred: `new Uint8Array(n)` yields an
// ArrayBuffer-backed array, which Web Crypto's BufferSource requires on TS 5.7+.
// An explicit `: Uint8Array` annotation widens it to the wrong variant and fails.
function b64ToBytes(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToBytes(s: string) {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return b64ToBytes(t);
}

function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

export async function verifyLicense(opts: VerifyOptions): Promise<LicenseResult> {
  const parts = opts.token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed" };

  let header: { alg?: string; kid?: string };
  let claims: LicenseClaims;
  try {
    header = JSON.parse(b64urlToString(parts[0]));
    claims = JSON.parse(b64urlToString(parts[1]));
  } catch {
    return { valid: false, reason: "malformed" };
  }

  const kid = header.kid ?? claims.kid;
  const spkiB64 = kid ? opts.publicKeys[kid] : undefined;
  if (!spkiB64) return { valid: false, reason: "unknown_key" };

  // Verify the ES256 signature over "header.payload".
  let signatureOk = false;
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      b64ToBytes(spkiB64),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = b64urlToBytes(parts[2]); // raw r||s, 64 bytes for P-256
    signatureOk = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      sig,
      data,
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { valid: false, reason: "bad_signature", claims };

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || now >= claims.exp) {
    return { valid: false, reason: "expired", claims };
  }
  if (!Array.isArray(claims.bundleIds) || !claims.bundleIds.includes(opts.bundleId)) {
    return { valid: false, reason: "bundle_mismatch", claims };
  }

  return { valid: true, claims };
}

// Cheap re-check for a long-running session (no crypto): is the token still in date?
export function isExpired(claims: LicenseClaims, now = Math.floor(Date.now() / 1000)): boolean {
  return typeof claims.exp !== "number" || now >= claims.exp;
}
