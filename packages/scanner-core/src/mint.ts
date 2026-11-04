// mint.ts
// Shared KMS-signing logic used by both the mint-token CLI and the control-plane
// issuance Lambda. Keeping both callers on the same code path guarantees
// server-minted tokens are byte-compatible with the plugin's offline verifyLicense.

import { createHash, randomUUID } from "node:crypto";
import { KMSClient, SignCommand, GetPublicKeyCommand } from "@aws-sdk/client-kms";

// ── base64url ────────────────────────────────────────────────────────────────

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function strToB64url(s: string): string {
  return bytesToB64url(new TextEncoder().encode(s));
}

// Standard base64 (non-URL): used for the SPKI bytes returned to callers.
function uint8ToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// ── DER ECDSA signature → raw r‖s (P-256, 64 bytes) ────────────────────────
// KMS returns DER-encoded; Web Crypto's ECDSA verify expects raw r‖s.

export function derToRaw(der: Uint8Array): Uint8Array {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error("bad DER: expected SEQUENCE");
  let seqLen = der[offset++];
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    seqLen = 0;
    for (let i = 0; i < n; i++) seqLen = (seqLen << 8) | der[offset++];
  }
  const readInt = (): Uint8Array => {
    if (der[offset++] !== 0x02) throw new Error("bad DER: expected INTEGER");
    const len = der[offset++];
    const v = der.slice(offset, offset + len);
    offset += len;
    return v;
  };
  const norm = (b: Uint8Array): Uint8Array => {
    let x = b;
    while (x.length > 32 && x[0] === 0x00) x = x.slice(1);
    const out = new Uint8Array(32);
    out.set(x, 32 - x.length);
    return out;
  };
  const r = norm(readInt());
  const s = norm(readInt());
  const out = new Uint8Array(64);
  out.set(r, 0);
  out.set(s, 32);
  return out;
}

// ── kid: stable fingerprint of the SPKI bytes ───────────────────────────────

export function kidFromSpki(spkiBytes: Uint8Array): string {
  const hash = createHash("sha256").update(spkiBytes).digest();
  return bytesToB64url(new Uint8Array(hash)).slice(0, 16);
}

// ── KMS helpers ─────────────────────────────────────────────────────────────

export interface PublicKeyInfo {
  kid: string;
  spki: string; // standard base64, suitable for embedding in publicKeys map
}

export async function getPublicKeyInfo(kmsKeyId: string): Promise<PublicKeyInfo> {
  const kms = new KMSClient({});
  const res = await kms.send(new GetPublicKeyCommand({ KeyId: kmsKeyId }));
  if (!res.PublicKey) throw new Error("KMS returned no PublicKey");
  const spki = new Uint8Array(res.PublicKey);
  return { kid: kidFromSpki(spki), spki: uint8ToBase64(spki) };
}

// ── mintLicenseToken ─────────────────────────────────────────────────────────

export interface MintOptions {
  kmsKeyId: string;
  customerId: string;
  plan: string;
  bundleIds: string[];
  days: number;
  quota?: number;
}

export interface MintResult {
  token: string;
  jti: string;
  exp: number;  // unix seconds
  kid: string;
}

export async function mintLicenseToken(opts: MintOptions): Promise<MintResult> {
  const kms = new KMSClient({});

  const res = await kms.send(new GetPublicKeyCommand({ KeyId: opts.kmsKeyId }));
  if (!res.PublicKey) throw new Error("KMS returned no PublicKey");
  const spki = new Uint8Array(res.PublicKey);
  const kid = kidFromSpki(spki);

  const nowSec = Math.floor(Date.now() / 1000);
  const jti = "lic_" + randomUUID();
  const exp = nowSec + opts.days * 86400;

  const header = { alg: "ES256", typ: "JWT", kid };
  const payload: Record<string, unknown> = {
    sub: opts.customerId,
    plan: opts.plan,
    iat: nowSec,
    exp,
    bundleIds: opts.bundleIds,
    jti,
    kid,
  };
  if (opts.quota !== undefined) payload.quota = opts.quota;

  const signingInput =
    `${strToB64url(JSON.stringify(header))}.${strToB64url(JSON.stringify(payload))}`;

  const signed = await kms.send(new SignCommand({
    KeyId: opts.kmsKeyId,
    Message: new TextEncoder().encode(signingInput),
    MessageType: "RAW",
    SigningAlgorithm: "ECDSA_SHA_256",
  }));
  if (!signed.Signature) throw new Error("KMS Sign returned no Signature");

  const rawSig = derToRaw(new Uint8Array(signed.Signature));
  const token = `${signingInput}.${bytesToB64url(rawSig)}`;

  return { token, jti, exp, kid };
}
