#!/usr/bin/env node
// verify-token.ts
// Confirm a minted token validates against its public key, fully offline, using
// the SAME verifyLicense the plugin ships with. Run before wiring native code.
//
//   # get the kid + spki once:
//   node tools/mint-token.mjs --key-id <kms-key-arn> --public-key
//
//   # then check your stored token against it:
//   node --experimental-strip-types tools/verify-token.ts \
//     --token "<your-token>" --kid "<kid>" --spki "<base64-spki>" \
//     --bundle "<the --bundle you minted with>"

import { verifyLicense } from "../src/license.ts";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = "true";
      else { args[key] = next; i++; }
    }
  }
  return args;
}

const a = parseArgs(process.argv.slice(2));
for (const r of ["token", "kid", "spki", "bundle"]) {
  if (!a[r]) { console.error(`Missing --${r}`); process.exit(2); }
}

const res = await verifyLicense({
  token: a.token,
  bundleId: a.bundle,
  publicKeys: { [a.kid]: a.spki },
});

if (res.valid && res.claims) {
  console.log("VALID  ✓");
  console.log("  customer :", res.claims.sub);
  console.log("  plan     :", res.claims.plan);
  console.log("  expires  :", new Date(res.claims.exp * 1000).toISOString());
  console.log("  bundleIds:", res.claims.bundleIds.join(", "));
  if (res.claims.quota !== undefined) console.log("  quota    :", res.claims.quota);
  console.log("\nThis is exactly the result the plugin's init() will get on this device.");
  process.exit(0);
}

console.log("INVALID  ✗   reason:", res.reason);
const hints: Record<string, string> = {
  unknown_key: "the --kid doesn't match the token's kid, or --spki is for a different key",
  bad_signature: "the --spki doesn't correspond to the KMS key that signed this token",
  bundle_mismatch: "the --bundle isn't in the token's bundleIds (mint used --bundle <X>)",
  expired: "the token's exp is in the past — mint a fresh one",
  malformed: "the token string is truncated or not three dot-separated segments",
};
if (res.reason && hints[res.reason]) console.log("  ->", hints[res.reason]);
process.exit(1);
