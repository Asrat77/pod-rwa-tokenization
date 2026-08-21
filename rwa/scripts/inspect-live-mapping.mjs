// Read-only inspector: maps Beka's live platform records onto RWA DealTerms fields.
//
// Answers "does an RWA deal actually fit a real Contract?" against the deployed
// dev data, without needing repo access to the platform app. Reads nothing but
// DynamoDB, writes nothing, and redacts PII before printing.
//
// Usage:
//   node rwa/scripts/inspect-live-mapping.mjs
//   AWS_PROFILE=turmi-dev TABLE=turmi-dev-domain node rwa/scripts/inspect-live-mapping.mjs
//
// Requires only the aws CLI (no SDK install).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  isPlaceholderPriced,
  resolveContractUsdAmount,
} from "../client/dist/fx.js";

const PROFILE = process.env.AWS_PROFILE ?? "turmi-dev";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const TABLE = process.env.TABLE ?? "turmi-dev-domain";
const CLUSTER = process.env.RWA_CLUSTER ?? "devnet";

const PII = /name|email|phone|tin|signature|address|username|cognito|representative/i;
const redact = (k, v) => (PII.test(k) ? "<redacted>" : v);

function ddb(args) {
  const out = execFileSync("aws", ["dynamodb", ...args, "--profile", PROFILE, "--region", REGION, "--output", "json"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out.toString());
}

const unwrap = (av) => {
  if (av == null) return undefined;
  const [t, v] = Object.entries(av)[0];
  if (t === "S" || t === "B") return v;
  if (t === "N") return Number(v);
  if (t === "BOOL") return v;
  if (t === "NULL") return null;
  if (t === "L") return v.map(unwrap);
  if (t === "M") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unwrap(x)]));
  return v;
};

const flatten = (item) => Object.fromEntries(Object.entries(item).map(([k, v]) => [k, unwrap(v)]));

function byType(entityType, limit = 25) {
  const res = ddb([
    "scan", "--table-name", TABLE,
    "--filter-expression", "entityType = :t",
    "--expression-attribute-values", JSON.stringify({ ":t": { S: entityType } }),
    "--max-items", String(limit),
  ]);
  return (res.Items ?? []).map(flatten);
}

const sha = (v) => createHash("sha256").update(String(v)).digest("hex");
const short = (h) => (h ? `${h.slice(0, 10)}…` : "—");

// USDC is six-decimal integer base units. Platform amounts are GraphQL Floats,
// so this conversion is the precision boundary between the two systems.
function toBaseUnits(contract) {
  // Canonical resolver lives in rwa/client/src/fx.ts — imported, never duplicated,
  // so the placeholder rate cannot drift between the library and this script.
  try {
    const r = resolveContractUsdAmount(contract, { cluster: CLUSTER });
    return { ok: true, value: r.baseUnits, source: r.source, rate: r.rateApplied, warning: r.warning, placeholder: isPlaceholderPriced(r) };
  } catch (error) {
    return { ok: false, note: error.message ?? String(error) };
  }
}

console.log(`\nRWA ↔ platform mapping inspector`);
console.log(`table ${TABLE} · profile ${PROFILE} · ${REGION}\n`);

const users = byType("USER");
const mses = users.filter((u) => String(u.role ?? "").toUpperCase() === "MSE");
const contracts = byType("CONTRACT");
const requests = byType("FINANCING_REQUEST");
const farms = byType("FARM");

console.log(`found: ${contracts.length} contracts · ${requests.length} financing requests · ${farms.length} farms · ${users.length} users (${mses.length} with role MSE)\n`);

console.log("══════ MSE registry candidates ══════");
if (!mses.length) {
  console.log("  none — no USER has role=MSE, so nothing can be registered as a beneficiary yet\n");
} else {
  for (const m of mses) {
    console.log(`  platform MSE id      ${m.id}`);
    console.log(`    entity_hash        ${short(sha(m.id))}  (sha256 of the platform id)`);
    console.log(`    businessName       ${redact("businessName", m.businessName)}`);
    console.log(`    operatingArea      ${m.operatingArea ?? "—"}   status ${m.status ?? "—"}`);
    console.log(`    wallet_owner       ${m.solanaWallet ?? "*** MISSING — must be captured ***"}`);
    console.log(`    usdc_ata           ${m.usdcAta ?? "*** MISSING — derived from wallet ***"}`);
    console.log(`    rail_kind          ${m.rwaRailKind ?? "(defaults to SQUADS_FIAT_FORWARD in V1)"}`);
    console.log();
  }
}

console.log("══════ Contract → DealTerms ══════");
const gaps = new Map();
const addGap = (g, why) => gaps.set(g, why);

for (const c of contracts.slice(0, 5)) {
  const fr = requests.find((r) => r.id === c.financingRequestId);
  const base = toBaseUnits(c);
  console.log(`  contract ${c.id}   status=${c.status ?? "—"}  scope=${c.contractScope ?? "—"}`);
  console.log(`    deal_id                 ${short(sha(c.id))}`);
  console.log(`    source_contract_hash    ${short(sha(JSON.stringify(c)))}   (canonical contract)`);
  console.log(`    document_bundle_hash    ${c.documentHash ? short(c.documentHash) : "*** MISSING ***"}`);
  console.log(`    asset_set_hash          ${c.farmId ? short(sha(c.farmId)) : "*** MISSING ***"}   (farmId)`);
  console.log(`    beneficiary_entity_hash ${c.assignedMseId ? short(sha(c.assignedMseId)) : "*** NO assignedMseId ***"}`);
  console.log(`    hard_cap (USDC base)    ${base.ok ? base.value : "*** UNRESOLVABLE ***"}`);
    console.log(`    usd rate source         ${base.ok ? base.source + (base.placeholder ? `  @ ${base.rate}  ⚠ UNVERIFIED PLACEHOLDER` : `  @ ${base.rate}`) : base.note}`);
  console.log(`    maturity_at             ${c.expectedDeliveryDate ?? "*** MISSING ***"}`);
  console.log(`    coupon_bps              *** NOT ON CONTRACT ***  (repaymentMode=${c.repaymentMode ?? "—"})`);
  console.log(`    minimum_raise           *** NOT ON CONTRACT ***`);
  console.log(`    subscription window     ${fr?.approvedAt ? `open≈${fr.approvedAt} (from request)` : "*** NOT ON CONTRACT ***"}`);
  console.log();

  if (!c.assignedMseId) addGap("assignedMseId unset", "a deal cannot pin a beneficiary without it");
  if (!c.documentHash) addGap("documentHash missing", "document_bundle_hash has no source");
  if (!base.ok) addGap("no USD amount", base.note);
  else if (base.placeholder) addGap("placeholder FX pricing", `${c.id} priced at the unverified ${base.rate}/USD default — blocked on mainnet, must be replaced before a priced offering`);
}

console.log("══════ Gaps blocking a real deal ══════");
const fixed = [
  ["coupon_bps", "no coupon field on Contract — open decision 2 (fixed vs accrued)"],
  ["MSE wallet + ATA", "PlatformUser has no Solana wallet field — registry cannot be driven from platform identity yet"],
  ["minimum_raise", "no minimum-raise concept on Contract"],
  ["subscription window", "Contract has delivery dates, not a funding window"],
];
for (const [k, v] of fixed) console.log(`  • ${k}: ${v}`);
for (const [k, v] of gaps) console.log(`  • ${k}: ${v}`);
console.log();

// ---- raw contract view: node inspect-live-mapping.mjs --raw ----
if (process.argv.includes("--raw")) {
  const ECON = /amount|value|price|quantity|unit|rate|fx|advance|repayment|commodity|scope|type|status|date|window|interval|mse|farm|id$|hash|mode|deduction/i;
  console.log("══════ raw CONTRACT fields (PII redacted) ══════");
  for (const c of contracts) {
    console.log(`\n  ── ${c.id} ──`);
    for (const k of Object.keys(c).sort()) {
      if (!ECON.test(k)) continue;
      const v = redact(k, c[k]);
      console.log(`    ${k.padEnd(26)} ${typeof v === "object" ? JSON.stringify(v).slice(0, 70) : String(v).slice(0, 70)}`);
    }
  }
  console.log();
}

// ---- deep view: node inspect-live-mapping.mjs --deep ----
if (process.argv.includes("--deep")) {
  const keysOf = (o) => Object.keys(o).sort();
  const has = (o, re) => keysOf(o).filter((k) => re.test(k));

  console.log("══════ FARM: can it feed the oracle gate? ══════");
  const trancheRe = /tranche|plow|health|yield|harvest|ndvi|analyz|oracle|confidence|score/i;
  for (const f of farms) {
    const t = has(f, trancheRe);
    console.log(`  ${String(f.id).padEnd(18)} mse=${f.assignedMseId ?? "—"}  status=${f.status ?? "—"}`);
    console.log(`      tranche/oracle fields: ${t.length ? t.join(", ") : "*** NONE ***"}`);
    const geo = has(f, /plot|geom|polygon|boundary|hectare|area|coordinate/i);
    console.log(`      geometry fields:       ${geo.length ? geo.join(", ") : "*** NONE ***"}`);
  }

  console.log("\n══════ FINANCING_REQUEST → Contract linkage ══════");
  for (const r of requests) {
    const linked = contracts.filter((c) => c.financingRequestId === r.id).map((c) => c.id);
    console.log(`  ${String(r.id).padEnd(18)} status=${String(r.status).padEnd(10)} farm=${r.farmId}`);
    console.log(`      requested: agronomy=${r.agronomyRequested} husbandry=${r.husbandryRequested} infra=${r.infrastructureRequested}`);
    console.log(`      contracts: ${linked.length ? linked.join(", ") : "*** NONE — orphan request ***"}`);
  }

  console.log("\n══════ Contracts with NO financing request ══════");
  const orphanContracts = contracts.filter((c) => !c.financingRequestId);
  console.log(orphanContracts.length ? orphanContracts.map((c) => `  ${c.id}`).join("\n") : "  (none)");

  console.log("\n══════ USER roles ══════");
  const byRole = {};
  for (const u of users) (byRole[u.role ?? "(none)"] ||= []).push(u);
  for (const [role, list] of Object.entries(byRole)) {
    console.log(`  ${role.padEnd(14)} ${list.length}  statuses=${[...new Set(list.map((u) => u.status))].join(",")}`);
    const wallet = list.flatMap((u) => has(u, /wallet|solana|pubkey|address/i));
    if (wallet.length) console.log(`      wallet-ish fields: ${[...new Set(wallet)].join(", ")}`);
  }
  const financiers = byRole.FINANCIER ?? [];
  console.log(`\n  FINANCIER (= RWA investor candidates): ${financiers.length}`);
  console.log(financiers.length ? "" : "  *** NO FINANCIER users — nobody can subscribe to a deal ***");
  console.log();
}

// ---- gate feasibility: node inspect-live-mapping.mjs --gate ----
if (process.argv.includes("--gate")) {
  console.log("══════ Oracle gate feasibility (actual values) ══════");
  const seen = new Map();
  for (const f of farms) {
    const k = f.id;
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(f);
  }
  console.log(`  unique farms: ${seen.size}   raw FARM items: ${farms.length}\n`);
  for (const [id, recs] of seen) {
    const f = recs[0];
    console.log(`  ${id}  (${recs.length} record${recs.length > 1 ? "s — DUPLICATE" : ""})  status=${f.status}`);
    console.log(`      SKs: ${recs.map((r) => r.__sk ?? "?").join(" | ")}`);
    console.log(`      T1 ${String(f.oracleTranche1Status ?? "—").padEnd(10)} conf=${f.oraclePlowConfidence ?? "—"}   at=${f.oracleTranche1AnalyzedAt ?? "—"}`);
    console.log(`      T2 ${String(f.oracleTranche2Status ?? "—").padEnd(10)} health=${f.oracleHealthScore ?? "—"}   at=${f.oracleTranche2AnalyzedAt ?? "—"}`);
    console.log(`      T3 ${String(f.oracleTranche3Status ?? "—").padEnd(10)} yield=${f.estimatedYield ?? "—"} ${f.estimatedYieldUnit ?? ""}  harvest=${f.predictedHarvestDate ?? "—"}`);
    console.log(`      geo: ${f.areaHectares ?? "—"} ha, plots=${f.plotCount ?? "—"}, boundary=${f.boundaryGeoJson ? "present" : "*** MISSING ***"}`);
  }
  console.log();
}
