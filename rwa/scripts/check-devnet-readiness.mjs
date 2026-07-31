import { readFile } from "node:fs/promises";

const manifestUrl = new URL("../deployments/devnet.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  if (!response.ok) {
    throw new Error(`${method} failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`${method} failed: ${payload.error.message}`);
  }
  return payload.result;
}

const checks = [];
const record = (name, pass, detail) => checks.push({ name, pass, detail });

try {
  const genesisHash = await rpc("getGenesisHash");
  record(
    "cluster genesis",
    genesisHash === manifest.genesisHash,
    `expected ${manifest.genesisHash}, received ${genesisHash}`,
  );

  const programEntries = Object.entries(manifest.programs);
  const settlementEntries = Object.entries(manifest.settlementAssets);
  const addresses = [
    ...programEntries.map(([, address]) => address),
    ...settlementEntries.map(([, asset]) => asset.mint),
  ];
  const accounts = await rpc("getMultipleAccounts", [
    addresses,
    { commitment: "confirmed", encoding: "base64" },
  ]);

  programEntries.forEach(([name, address], index) => {
    const account = accounts.value[index];
    record(
      `program ${name}`,
      Boolean(account?.executable),
      account
        ? `${address} exists; executable=${account.executable}; owner=${account.owner}`
        : `${address} does not exist`,
    );
  });

  settlementEntries.forEach(([symbol, asset], index) => {
    const account = accounts.value[programEntries.length + index];
    record(
      `settlement asset ${symbol}`,
      Boolean(account && account.owner === asset.tokenProgram),
      account
        ? `${asset.mint} owner=${account.owner}; expected ${asset.tokenProgram}`
        : `${asset.mint} does not exist`,
    );
  });

  Object.entries(manifest.authorities).forEach(([name, address]) => {
    record(
      `authority ${name}`,
      typeof address === "string" && address.length > 0,
      address || "not configured",
    );
  });

  const integrityFields = [
    ["generatedAt", manifest.generatedAt],
    ["sourceCommit", manifest.sourceCommit],
    ["signedBy", manifest.signedBy],
    ["signature", manifest.signature],
    ["binaryHashes", Object.keys(manifest.binaryHashes || {}).length],
    ["idlHashes", Object.keys(manifest.idlHashes || {}).length],
  ];
  integrityFields.forEach(([name, value]) => {
    record(
      `manifest ${name}`,
      Boolean(value),
      value ? "configured" : "not configured",
    );
  });

  const ready = checks.every((check) => check.pass);
  console.log(JSON.stringify({
    cluster: manifest.cluster,
    rpcUrl,
    slot: accounts.context.slot,
    ready,
    checks,
  }, null, 2));
  if (!ready) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    cluster: manifest.cluster,
    rpcUrl,
    ready: false,
    error: error instanceof Error ? error.message : String(error),
    checks,
  }, null, 2));
  process.exitCode = 1;
}
