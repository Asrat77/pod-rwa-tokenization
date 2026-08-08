'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadConfig, parseSecretRpcUrl } = require('./config');

const CONFIG_ENV_KEYS = [
  'TABLE_NAME',
  'SOLANA_RPC_URL',
  'SOLANA_RPC_SECRET_ARN',
  'RWA_PROGRAM_ID',
  'RWA_CLUSTER_GENESIS',
];

async function withConfigEnv(values, callback) {
  const previous = Object.fromEntries(
    CONFIG_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  try {
    for (const key of CONFIG_ENV_KEYS) delete process.env[key];
    Object.assign(process.env, values);
    return await callback();
  } finally {
    for (const key of CONFIG_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('loads the credential-free RPC configuration', async () => {
  await withConfigEnv({
    TABLE_NAME: 'turmi-dev-domain',
    SOLANA_RPC_URL: 'https://api.devnet.solana.com',
    RWA_PROGRAM_ID: 'GREmSWM6ugPjoKeA6tr9RxkhWHvToiYnNpV1dwNySWCn',
    RWA_CLUSTER_GENESIS: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  }, async () => {
    const config = await loadConfig();
    assert.equal(config.tableName, 'turmi-dev-domain');
    assert.equal(config.rpcUrl, 'https://api.devnet.solana.com');
    assert.equal(config.maxItemsPerRun, 20_000);
  });
});

test('rejects a non-HTTP RPC endpoint before polling', async () => {
  await withConfigEnv({
    TABLE_NAME: 'turmi-dev-domain',
    SOLANA_RPC_URL: 'file:///tmp/solana.sock',
    RWA_PROGRAM_ID: 'GREmSWM6ugPjoKeA6tr9RxkhWHvToiYnNpV1dwNySWCn',
    RWA_CLUSTER_GENESIS: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  }, async () => {
    await assert.rejects(
      loadConfig(),
      /SOLANA_RPC_URL must use HTTP or HTTPS/,
    );
  });
});

test('loads a credentialed RPC URL from a raw secret string', async () => {
  await withConfigEnv({
    TABLE_NAME: 'turmi-dev-domain',
    SOLANA_RPC_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:rwa-rpc',
    RWA_PROGRAM_ID: 'GREmSWM6ugPjoKeA6tr9RxkhWHvToiYnNpV1dwNySWCn',
    RWA_CLUSTER_GENESIS: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  }, async () => {
    const config = await loadConfig({
      loadSecretString: async () => 'https://devnet.example.test/rpc?key=secret',
    });
    assert.equal(config.rpcUrl, 'https://devnet.example.test/rpc?key=secret');
  });
});

test('loads a credentialed RPC URL from a JSON secret string', async () => {
  await withConfigEnv({
    TABLE_NAME: 'turmi-dev-domain',
    SOLANA_RPC_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:rwa-rpc',
    RWA_PROGRAM_ID: 'GREmSWM6ugPjoKeA6tr9RxkhWHvToiYnNpV1dwNySWCn',
    RWA_CLUSTER_GENESIS: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  }, async () => {
    const config = await loadConfig({
      loadSecretString: async () => JSON.stringify({
        rpcUrl: 'https://devnet.example.test/rpc?key=secret',
      }),
    });
    assert.equal(config.rpcUrl, 'https://devnet.example.test/rpc?key=secret');
  });
});

test('rejects ambiguous direct and secret RPC configuration', async () => {
  await withConfigEnv({
    TABLE_NAME: 'turmi-dev-domain',
    SOLANA_RPC_URL: 'https://api.devnet.solana.com',
    SOLANA_RPC_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:rwa-rpc',
    RWA_PROGRAM_ID: 'GREmSWM6ugPjoKeA6tr9RxkhWHvToiYnNpV1dwNySWCn',
    RWA_CLUSTER_GENESIS: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  }, async () => {
    await assert.rejects(
      loadConfig(),
      /Set exactly one of SOLANA_RPC_URL or SOLANA_RPC_SECRET_ARN/,
    );
  });
});

test('rejects JSON secrets without an RPC URL', () => {
  assert.throws(
    () => parseSecretRpcUrl(JSON.stringify({ endpoint: 'https://example.test' })),
    /Solana RPC secret JSON must contain a string rpcUrl field/,
  );
});
