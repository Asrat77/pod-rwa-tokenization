'use strict';

const { base58Decode } = require('./decoder');

const DEFAULT_RPC_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ACCOUNTS_PER_TYPE = 5_000;
const DEFAULT_MAX_ITEMS_PER_RUN = 20_000;
const DEFAULT_MAX_SIGNATURE_LOOKUPS = 250;
const DEFAULT_RPC_BATCH_SIZE = 50;
const DEFAULT_DYNAMO_WRITE_PAGE_SIZE = 10;

function integerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

async function fetchSecretString(secretArn) {
    const {
      GetSecretValueCommand,
      SecretsManagerClient,
    } = require('@aws-sdk/client-secrets-manager');
    const response = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    if (!response.SecretString) {
      throw new Error('Solana RPC secret must contain SecretString');
    }
    return response.SecretString;
}

function parseSecretRpcUrl(secretString) {
    try {
      const parsed = JSON.parse(secretString);
      if (typeof parsed.rpcUrl === 'string') return parsed.rpcUrl;
    } catch {
      return secretString;
    }
    throw new Error('Solana RPC secret JSON must contain a string rpcUrl field');
}

async function loadRpcUrl(loadSecretString = fetchSecretString) {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const secretArn = process.env.SOLANA_RPC_SECRET_ARN;
  if (rpcUrl && secretArn) {
    throw new Error(
      'Set exactly one of SOLANA_RPC_URL or SOLANA_RPC_SECRET_ARN',
    );
  }
  if (secretArn) {
    return parseSecretRpcUrl(await loadSecretString(secretArn));
  }
  return rpcUrl;
}

async function loadConfig(options = {}) {
  const tableName = process.env.TABLE_NAME;
  const rpcUrl = await loadRpcUrl(options.loadSecretString);
  const programId = process.env.RWA_PROGRAM_ID;
  const clusterGenesis = process.env.RWA_CLUSTER_GENESIS;
  if (!tableName) throw new Error('TABLE_NAME is required');
  if (!rpcUrl) {
    throw new Error('SOLANA_RPC_URL or SOLANA_RPC_SECRET_ARN is required');
  }
  if (!programId) throw new Error('RWA_PROGRAM_ID is required');
  if (!clusterGenesis) throw new Error('RWA_CLUSTER_GENESIS is required');

  let parsedRpcUrl;
  try {
    parsedRpcUrl = new URL(rpcUrl);
  } catch {
    throw new Error('SOLANA_RPC_URL must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsedRpcUrl.protocol)) {
    throw new Error('SOLANA_RPC_URL must use HTTP or HTTPS');
  }

  const programBytes = base58Decode(programId);
  if (programBytes.length !== 32) {
    throw new Error('RWA_PROGRAM_ID must be a 32-byte Solana public key');
  }
  return {
    tableName,
    rpcUrl,
    programId,
    clusterGenesis,
    rpcTimeoutMs: integerEnv(
      'RPC_TIMEOUT_MS',
      DEFAULT_RPC_TIMEOUT_MS,
      1_000,
      120_000,
    ),
    maxAccountsPerType: integerEnv(
      'MAX_ACCOUNTS_PER_TYPE',
      DEFAULT_MAX_ACCOUNTS_PER_TYPE,
      1,
      100_000,
    ),
    maxItemsPerRun: integerEnv(
      'MAX_ITEMS_PER_RUN',
      DEFAULT_MAX_ITEMS_PER_RUN,
      1,
      100_000,
    ),
    maxSignatureLookups: integerEnv(
      'MAX_SIGNATURE_LOOKUPS',
      DEFAULT_MAX_SIGNATURE_LOOKUPS,
      0,
      10_000,
    ),
    rpcBatchSize: integerEnv(
      'RPC_BATCH_SIZE',
      DEFAULT_RPC_BATCH_SIZE,
      1,
      100,
    ),
    dynamoWritePageSize: integerEnv(
      'DYNAMO_WRITE_PAGE_SIZE',
      DEFAULT_DYNAMO_WRITE_PAGE_SIZE,
      1,
      25,
    ),
  };
}

module.exports = { loadConfig, parseSecretRpcUrl };
