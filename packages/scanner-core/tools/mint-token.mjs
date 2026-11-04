#!/usr/bin/env node
// mint-token.mjs — CLI wrapper around the shared mint module.
// All signing logic lives in src/mint.ts (compiled to dist/mint.js).
// Run `npm run build` once before first use.
//
//   # 1) export the public key + kid to embed in the plugin
//   node tools/mint-token.mjs --key-id <kms-key-arn> --public-key
//
//   # 2) mint a trial token for a customer
//   node tools/mint-token.mjs --key-id <kms-key-arn> \
//       --customer acme --plan trial --days 30 \
//       --bundle com.acme.app --quota 50000

import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load from compiled dist so CLI and Lambda share the exact same code path.
const distPath = join(__dirname, "../dist/mint.js");
let mint;
try {
  mint = await import(distPath);
} catch {
  console.error("Could not load dist/mint.js — run `npm run build` first.");
  process.exit(1);
}

const { getPublicKeyInfo, mintLicenseToken } = mint;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else { args[key] = next; i++; }
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const keyId = args["key-id"];
if (!keyId) { console.error("Missing --key-id"); process.exit(1); }

if (args["public-key"]) {
  const { kid, spki } = await getPublicKeyInfo(keyId);
  console.log(JSON.stringify({ kid, spki }, null, 2));
  console.log("\n// add to the plugin's publicKeys map:");
  console.log(`//   { "${kid}": "${spki}" }`);
  process.exit(0);
}

const days = Number(args.days ?? 30);
const bundleIds = args.bundle ? String(args.bundle).split(",") : [];
const customerId = args.customer ?? "customer";
const plan = args.plan ?? "trial";
const quota = args.quota !== undefined ? Number(args.quota) : undefined;

const { token, jti, exp } = await mintLicenseToken({
  kmsKeyId: keyId,
  customerId,
  plan,
  bundleIds,
  days,
  quota,
});

console.error(`# token for ${customerId} (${plan}), expires in ${days}d, jti ${jti}`);
console.log(token);
