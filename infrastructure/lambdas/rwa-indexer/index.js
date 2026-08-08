'use strict';

const crypto = require('node:crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  BatchGetCommand,
  DynamoDBDocumentClient,
  PutCommand,
} = require('@aws-sdk/lib-dynamodb');
const {
  ACCOUNT_DISCRIMINATORS,
  ACCOUNT_NAMES,
  base58Decode,
  base58Encode,
  decodeAccount,
  expectedVaultAccountAddress,
} = require('./decoder');
const { loadConfig } = require('./config');
const { buildMirrorItems } = require('./mapper');

function createRpcClient(config) {
  let nextId = 1;

  async function post(payload) {
    const response = await fetch(config.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.rpcTimeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 512);
      throw new Error(`Solana RPC HTTP ${response.status}: ${detail}`);
    }
    return response.json();
  }

  async function rpc(method, params = []) {
    const id = nextId;
    nextId += 1;
    const response = await post({ jsonrpc: '2.0', id, method, params });
    if (response?.id !== id) throw new Error(`Solana RPC ${method} returned a mismatched id`);
    if (response.error) {
      throw new Error(
        `Solana RPC ${method} failed (${response.error.code}): ${response.error.message}`,
      );
    }
    return response.result;
  }

  async function batch(calls) {
    if (calls.length === 0) return [];
    const requests = calls.map((call) => {
      const id = nextId;
      nextId += 1;
      return {
        jsonrpc: '2.0',
        id,
        method: call.method,
        params: call.params || [],
      };
    });
    const response = await post(requests);
    if (!Array.isArray(response)) throw new Error('Solana RPC batch returned a non-array response');
    const byId = new Map(response.map((item) => [item.id, item]));
    return requests.map((request) => {
      const item = byId.get(request.id);
      if (!item) {
        return { error: new Error(`Solana RPC omitted batch response ${request.id}`) };
      }
      if (item.error) {
        return {
          error: new Error(
            `Solana RPC ${request.method} failed (${item.error.code}): ${item.error.message}`,
          ),
        };
      }
      return { result: item.result };
    });
  }

  return { batch, rpc };
}

async function validateRpcTarget(rpcClient, config) {
  const genesis = await rpcClient.rpc('getGenesisHash');
  if (genesis !== config.clusterGenesis) {
    throw new Error(
      `Solana genesis mismatch: expected ${config.clusterGenesis}, received ${genesis}`,
    );
  }

  const programResponse = await rpcClient.rpc('getAccountInfo', [
    config.programId,
    { commitment: 'finalized', encoding: 'base64' },
  ]);
  if (!programResponse?.value) {
    throw new Error(`RWA program ${config.programId} does not exist on the configured cluster`);
  }
  if (programResponse.value.executable !== true) {
    throw new Error(`RWA program ${config.programId} is not executable`);
  }

  const minimumContextSlot = await rpcClient.rpc('getSlot', [
    { commitment: 'finalized' },
  ]);
  if (!Number.isSafeInteger(minimumContextSlot) || minimumContextSlot < 0) {
    throw new Error('Solana RPC returned an invalid finalized slot');
  }
  return { genesis, minimumContextSlot };
}

function decodeProgramAccount(entry, name, slot, config) {
  if (!entry || typeof entry.pubkey !== 'string' || !entry.account) {
    throw new Error(`${name} getProgramAccounts returned a malformed entry`);
  }
  if (base58Decode(entry.pubkey).length !== 32) {
    throw new Error(`${name} returned invalid account address ${entry.pubkey}`);
  }
  if (entry.account.owner !== config.programId) {
    throw new Error(
      `${name} account ${entry.pubkey} owner is ${entry.account.owner}, not ${config.programId}`,
    );
  }
  if (entry.account.executable) {
    throw new Error(`${name} account ${entry.pubkey} unexpectedly contains executable data`);
  }
  const encoded = entry.account.data;
  if (!Array.isArray(encoded) || encoded[1] !== 'base64' || typeof encoded[0] !== 'string') {
    throw new Error(`${name} account ${entry.pubkey} did not return base64 data`);
  }
  if (
    encoded[0].length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded[0],
    )
  ) {
    throw new Error(`${name} account ${entry.pubkey} contains invalid base64 data`);
  }
  const data = Buffer.from(encoded[0], 'base64');
  const decoded = decodeAccount(name, data);
  const expectedAddress = expectedVaultAccountAddress(name, decoded, config.programId);
  if (entry.pubkey !== expectedAddress) {
    throw new Error(
      `${name} account ${entry.pubkey} is not its canonical PDA ${expectedAddress}`,
    );
  }
  return {
    name,
    address: entry.pubkey,
    slot,
    data,
    decoded,
    accountHash: crypto.createHash('sha256').update(data).digest('hex'),
    signature: null,
  };
}

async function fetchAccountsByType(rpcClient, config, minimumContextSlot) {
  const calls = ACCOUNT_NAMES.map((name) => ({
    method: 'getProgramAccounts',
    params: [
      config.programId,
      {
        commitment: 'finalized',
        encoding: 'base64',
        withContext: true,
        minContextSlot: minimumContextSlot,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: base58Encode(ACCOUNT_DISCRIMINATORS[name]),
            },
          },
        ],
      },
    ],
  }));
  const responses = await rpcClient.batch(calls);
  const accountsByType = {};

  for (let index = 0; index < ACCOUNT_NAMES.length; index += 1) {
    const name = ACCOUNT_NAMES[index];
    const response = responses[index];
    if (response.error) throw response.error;
    const payload = response.result;
    if (!payload?.context || !Array.isArray(payload.value)) {
      throw new Error(`${name} getProgramAccounts response did not include context`);
    }
    const slot = payload.context.slot;
    if (!Number.isSafeInteger(slot) || slot < minimumContextSlot) {
      throw new Error(
        `${name} returned slot ${slot}, below required finalized slot ${minimumContextSlot}`,
      );
    }
    if (payload.value.length > config.maxAccountsPerType) {
      throw new Error(
        `${name} returned ${payload.value.length} accounts, exceeding `
          + `MAX_ACCOUNTS_PER_TYPE=${config.maxAccountsPerType}`,
      );
    }
    accountsByType[name] = payload.value.map(
      (entry) => decodeProgramAccount(entry, name, slot, config),
    );
  }
  return accountsByType;
}

function chunk(values, size) {
  const pages = [];
  for (let index = 0; index < values.length; index += size) {
    pages.push(values.slice(index, index + size));
  }
  return pages;
}

async function attachLatestSignatures(rpcClient, accountsByType, config) {
  const priority = [
    'DealStateAccount',
    'DealTerms',
    'TreasuryMovement',
    'ReleaseMilestone',
    'SettlementSnapshot',
    'InvestorDealPosition',
  ];
  const selected = priority
    .flatMap((name) => accountsByType[name])
    .slice(0, config.maxSignatureLookups);
  const warnings = [];

  for (const page of chunk(selected, config.rpcBatchSize)) {
    let responses;
    try {
      responses = await rpcClient.batch(
        page.map((account) => ({
          method: 'getSignaturesForAddress',
          params: [account.address, { commitment: 'finalized', limit: 10 }],
        })),
      );
    } catch (error) {
      warnings.push(`Signature lookup page failed: ${error.message}`);
      continue;
    }
    for (let index = 0; index < page.length; index += 1) {
      const response = responses[index];
      if (response.error) {
        warnings.push(
          `Signature lookup failed for ${page[index].address}: ${response.error.message}`,
        );
        continue;
      }
      const signature = response.result?.find(
        (entry) => entry?.err === null
          && Number.isSafeInteger(entry.slot)
          && entry.slot <= page[index].slot,
      )?.signature;
      if (typeof signature === 'string' && signature.length > 0) {
        page[index].signature = signature;
      }
    }
  }

  return {
    attempted: selected.length,
    omitted: Math.max(
      0,
      Object.values(accountsByType).reduce((sum, accounts) => sum + accounts.length, 0)
        - selected.length,
    ),
    warnings,
  };
}

function createDocumentClient() {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: {
      removeUndefinedValues: true,
      convertClassInstanceToMap: false,
    },
  });
}

async function resolveInvestorBindings(documentClient, config, positionAccounts) {
  const wallets = [...new Set(
    positionAccounts.map((account) => account.decoded.wallet),
  )];
  const bindings = new Map();

  for (const walletPage of chunk(wallets, 100)) {
    let pendingKeys = walletPage.map((wallet) => ({
      PK: `RWA#WALLET#${wallet}`,
      SK: 'OWNER',
    }));
    for (let attempt = 0; pendingKeys.length > 0 && attempt < 5; attempt += 1) {
      const response = await documentClient.send(new BatchGetCommand({
        RequestItems: {
          [config.tableName]: {
            Keys: pendingKeys,
            ConsistentRead: true,
            ProjectionExpression: 'PK, investorId',
          },
        },
      }));
      for (const item of response.Responses?.[config.tableName] || []) {
        if (
          typeof item.PK === 'string'
          && item.PK.startsWith('RWA#WALLET#')
          && typeof item.investorId === 'string'
          && item.investorId.length > 0
        ) {
          bindings.set(item.PK.slice('RWA#WALLET#'.length), item.investorId);
        }
      }
      pendingKeys = response.UnprocessedKeys?.[config.tableName]?.Keys || [];
      if (pendingKeys.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (2 ** attempt)));
      }
    }
    if (pendingKeys.length > 0) {
      throw new Error(
        `DynamoDB did not process ${pendingKeys.length} wallet binding lookups after retries`,
      );
    }
  }
  return bindings;
}

async function writeItem(documentClient, config, item) {
  try {
    await documentClient.send(new PutCommand({
      TableName: config.tableName,
      Item: item,
      ConditionExpression:
        'attribute_not_exists(PK) '
        + 'OR attribute_not_exists(indexedFinalizedSlot) '
        + 'OR attribute_not_exists(accountHash) '
        + 'OR (indexedFinalizedSlot <= :slot AND accountHash <> :hash)',
      ExpressionAttributeValues: {
        ':slot': item.indexedFinalizedSlot,
        ':hash': item.accountHash,
      },
    }));
    return 'written';
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') return 'unchanged';
    throw error;
  }
}

async function writeMirrorItems(documentClient, config, items) {
  const result = { written: 0, unchanged: 0 };
  for (const page of chunk(items, config.dynamoWritePageSize)) {
    const outcomes = await Promise.all(
      page.map((item) => writeItem(documentClient, config, item)),
    );
    for (const outcome of outcomes) result[outcome] += 1;
  }
  return result;
}

async function handler(event = {}) {
  const config = await loadConfig();
  const rpcClient = createRpcClient(config);

  // These checks deliberately precede creation/use of the DynamoDB client.
  const target = await validateRpcTarget(rpcClient, config);
  const accountsByType = await fetchAccountsByType(
    rpcClient,
    config,
    target.minimumContextSlot,
  );
  const signatureResult = await attachLatestSignatures(rpcClient, accountsByType, config);
  const documentClient = createDocumentClient();
  const investorBindingsByWallet = event.skipIdentityResolution === true
    ? new Map()
    : await resolveInvestorBindings(
      documentClient,
      config,
      accountsByType.InvestorDealPosition,
    );
  const reconciledAt = new Date().toISOString();
  const mapped = buildMirrorItems(accountsByType, {
    clusterGenesis: target.genesis,
    programId: config.programId,
    reconciledAt,
    nowUnixSeconds: BigInt(Math.floor(Date.now() / 1_000)),
    investorBindingsByWallet,
  });

  if (mapped.items.length > config.maxItemsPerRun) {
    throw new Error(
      `Indexer produced ${mapped.items.length} items, exceeding `
        + `MAX_ITEMS_PER_RUN=${config.maxItemsPerRun}`,
    );
  }

  let writes = { written: 0, unchanged: mapped.items.length };
  if (event.dryRun !== true) {
    writes = await writeMirrorItems(documentClient, config, mapped.items);
  }

  const result = {
    clusterGenesis: target.genesis,
    programId: config.programId,
    minimumFinalizedSlot: String(target.minimumContextSlot),
    dryRun: event.dryRun === true,
    accountCounts: Object.fromEntries(
      Object.entries(accountsByType).map(([name, accounts]) => [name, accounts.length]),
    ),
    mirror: mapped.summary,
    writes,
    signatureLookups: {
      attempted: signatureResult.attempted,
      omitted: signatureResult.omitted,
    },
    warningCount: mapped.warnings.length + signatureResult.warnings.length,
    reconciledAt,
  };
  if (mapped.warnings.length || signatureResult.warnings.length) {
    console.warn(JSON.stringify({
      event: 'rwa_indexer_warnings',
      warnings: [...mapped.warnings, ...signatureResult.warnings],
    }));
  }
  console.log(JSON.stringify({ event: 'rwa_indexer_complete', ...result }));
  return result;
}

module.exports = {
  handler,
  _test: {
    chunk,
    createRpcClient,
    decodeProgramAccount,
    fetchAccountsByType,
    loadConfig,
    validateRpcTarget,
    resolveInvestorBindings,
    writeMirrorItems,
  },
};
