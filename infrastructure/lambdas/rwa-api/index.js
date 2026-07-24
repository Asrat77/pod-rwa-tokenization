'use strict';

const crypto = require('node:crypto');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');

const tableName = process.env.TABLE_NAME;
const challengeDomain = process.env.RWA_CHALLENGE_DOMAIN || 'rwa.turmi.example';
const clusterGenesis = process.env.RWA_CLUSTER_GENESIS || 'unknown';
const programId = process.env.RWA_PROGRAM_ID || 'unknown';
const challengeTtlSeconds = 5 * 60;
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const treasuryStatuses = new Set([
  'PROPOSED',
  'APPROVED',
  'USDC_RELEASED',
  'CONVERTED',
  'SWIFT_SENT',
  'BANK_CONFIRMED',
  'RECONCILED',
  'FAILED',
  'RETURNED',
]);

const amountFields = new Set([
  'releasedUsdcBaseUnits',
  'grossUsdMinor',
  'netUsdMinor',
  'conversionRateE8',
  'providerFeesUsdMinor',
  'bankFeesUsdMinor',
  'netUsdcBaseUnits',
]);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const nowIso = () => new Date().toISOString();
const actorRef = (subject) => `actor_${sha256(subject).slice(0, 24)}`;
const investorRef = (subject) => `investor_${sha256(`investor:${subject}`).slice(0, 24)}`;
const movementKey = (id) => ({ PK: `RWA#MOVEMENT#${id}`, SK: 'META' });
const repaymentKey = (id) => ({ PK: `RWA#REPAYMENT#${id}`, SK: 'META' });

function identity(event) {
  const claims = event?.identity?.claims || {};
  const subject = claims.sub || event?.identity?.sub;
  if (!subject) throw new Error('Authenticated Cognito identity is required');
  const claimGroups = claims['cognito:groups'];
  const groups = new Set(
    Array.isArray(claimGroups)
      ? claimGroups
      : typeof claimGroups === 'string'
        ? claimGroups.split(',').map((group) => group.trim()).filter(Boolean)
        : [],
  );
  return { subject, groups };
}

function requireRole(auth, allowed) {
  if (!allowed.some((role) => auth.groups.has(role))) {
    throw new Error(`One of these roles is required: ${allowed.join(', ')}`);
  }
}

function assertText(name, value, max = 512) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`${name} must be a non-empty string no longer than ${max} characters`);
  }
  return value;
}

function assertHash(name, value) {
  assertText(name, value, 64);
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${name} must be a SHA-256 hex digest`);
  return value.toLowerCase();
}

function assertAmount(name, value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} must be an unsigned base-unit integer string`);
  }
  if (BigInt(value) > 18_446_744_073_709_551_615n) {
    throw new Error(`${name} exceeds the supported u64 range`);
  }
  return value;
}

function assertMovementShape(movement) {
  if (!treasuryStatuses.has(movement.status)) throw new Error('Invalid treasury movement status');
  for (const field of amountFields) {
    if (movement[field] !== undefined) assertAmount(field, movement[field]);
  }
  return movement;
}

function decodeBase58(value) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let decoded = 0n;
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('Invalid base58 value');
    decoded = decoded * 58n + BigInt(index);
  }
  let hex = decoded.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = decoded === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === '1') leadingZeroes += 1;
  return Buffer.concat([Buffer.alloc(leadingZeroes), body]);
}

function decodeSignature(value) {
  assertText('signature', value, 128);
  try {
    const base58 = decodeBase58(value);
    if (base58.length === 64) return base58;
  } catch {
    // Fall through to strict base64 support.
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Signature must be base58 or base64');
  const base64 = Buffer.from(value, 'base64');
  if (base64.length !== 64) throw new Error('Ed25519 signature must be 64 bytes');
  return base64;
}

function assertWallet(wallet) {
  assertText('wallet', wallet, 44);
  const decoded = decodeBase58(wallet);
  if (decoded.length !== 32) throw new Error('Wallet must be a 32-byte Solana public key');
  return decoded;
}

function verifyWalletSignature(wallet, message, signature) {
  const publicKeyBytes = assertWallet(wallet);
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([spkiPrefix, publicKeyBytes]),
    format: 'der',
    type: 'spki',
  });
  if (!crypto.verify(null, Buffer.from(message, 'utf8'), publicKey, decodeSignature(signature))) {
    throw new Error('Wallet signature does not match the challenge');
  }
}

function challengeMessage({ subject, wallet, nonce, expiresAt }) {
  return [
    'Turmi RWA wallet binding',
    `Domain: ${challengeDomain}`,
    `Cluster genesis: ${clusterGenesis}`,
    `Program: ${programId}`,
    `Investor subject: ${sha256(subject)}`,
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Expires at: ${expiresAt}`,
    'Purpose: bind this wallet to one opaque investor record. This is not a transaction.',
  ].join('\n');
}

async function getItem(key, consistent = true) {
  const result = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: key,
    ConsistentRead: consistent,
  }));
  return result.Item;
}

async function queryIndex(indexName, keyName, keyValue, ascending = true) {
  const result = await documentClient.send(new QueryCommand({
    TableName: tableName,
    IndexName: indexName,
    KeyConditionExpression: `${keyName} = :value`,
    ExpressionAttributeValues: { ':value': keyValue },
    ScanIndexForward: ascending,
  }));
  return result.Items || [];
}

async function createRwaWalletChallenge(event, auth) {
  const wallet = assertText('wallet', event.arguments.input.wallet, 44);
  assertWallet(wallet);
  const nonce = crypto.randomUUID();
  const expiresAtDate = new Date(Date.now() + challengeTtlSeconds * 1000);
  const responseExpiresAt = expiresAtDate.toISOString();
  const message = challengeMessage({
    subject: auth.subject,
    wallet,
    nonce,
    expiresAt: responseExpiresAt,
  });
  await documentClient.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: `RWA#CHALLENGE#${nonce}`,
      SK: 'META',
      entityType: 'RWA_WALLET_CHALLENGE',
      nonce,
      wallet,
      subjectHash: sha256(auth.subject),
      message,
      expiresAtEpoch: Math.floor(expiresAtDate.getTime() / 1000),
      consumed: false,
      createdAt: nowIso(),
      // DynamoDB TTL attribute configured on the shared domain table.
      expiresAt: Math.floor(expiresAtDate.getTime() / 1000),
      responseExpiresAt,
    },
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
  return { nonce, message, expiresAt: responseExpiresAt };
}

async function bindRwaWallet(event, auth) {
  const { nonce, wallet, signature } = event.arguments.input;
  assertText('nonce', nonce, 64);
  assertWallet(wallet);
  const challengeKey = { PK: `RWA#CHALLENGE#${nonce}`, SK: 'META' };
  const challenge = await getItem(challengeKey);
  if (!challenge || challenge.consumed) throw new Error('Wallet challenge is missing or already consumed');
  if (challenge.subjectHash !== sha256(auth.subject) || challenge.wallet !== wallet) {
    throw new Error('Wallet challenge is not bound to this identity and wallet');
  }
  if (challenge.expiresAt <= Math.floor(Date.now() / 1000)) throw new Error('Wallet challenge has expired');
  verifyWalletSignature(wallet, challenge.message, signature);

  const investorId = investorRef(auth.subject);
  const boundAt = nowIso();
  const existingEligibility = await getItem({ PK: `RWA#INVESTOR#${investorId}`, SK: 'ELIGIBILITY' });
  const status = existingEligibility?.status || 'SUSPENDED';
  const binding = {
    PK: `RWA#SUBJECT#${sha256(auth.subject)}`,
    SK: 'WALLET_BINDING',
    entityType: 'RWA_WALLET_BINDING',
    investorId,
    wallet,
    status,
    boundAt,
    GSI1PK: `RWA#WALLET#${wallet}`,
    GSI1SK: investorId,
  };
  const walletGuard = {
    PK: `RWA#WALLET#${wallet}`,
    SK: 'OWNER',
    entityType: 'RWA_WALLET_OWNER',
    investorId,
    subjectHash: sha256(auth.subject),
    createdAt: boundAt,
  };
  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: tableName,
          Key: challengeKey,
          UpdateExpression: 'SET consumed = :true, consumedAt = :now',
          ConditionExpression: 'consumed = :false AND subjectHash = :subjectHash AND wallet = :wallet',
          ExpressionAttributeValues: {
            ':true': true,
            ':false': false,
            ':now': boundAt,
            ':subjectHash': sha256(auth.subject),
            ':wallet': wallet,
          },
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: walletGuard,
          ConditionExpression: 'attribute_not_exists(PK) OR investorId = :investorId',
          ExpressionAttributeValues: { ':investorId': investorId },
        },
      },
      { Put: { TableName: tableName, Item: binding } },
    ],
  }));
  return { investorId, wallet, status, boundAt };
}

async function recoverRwaWallet(event, auth) {
  requireRole(auth, ['COMPLIANCE', 'SUPER_ADMIN']);
  const { investorId, replacementWallet, caseEvidenceHash } = event.arguments.input;
  assertText('investorId', investorId, 128);
  assertWallet(replacementWallet);
  assertHash('caseEvidenceHash', caseEvidenceHash);
  const recoveredAt = nowIso();
  const walletGuard = {
    PK: `RWA#WALLET#${replacementWallet}`,
    SK: 'OWNER',
    entityType: 'RWA_WALLET_OWNER',
    investorId,
    recoveryCaseEvidenceHash: caseEvidenceHash.toLowerCase(),
    createdAt: recoveredAt,
  };
  const binding = {
    PK: `RWA#INVESTOR#${investorId}`,
    SK: 'RECOVERY_BINDING',
    entityType: 'RWA_WALLET_RECOVERY',
    investorId,
    wallet: replacementWallet,
    status: 'SUSPENDED',
    boundAt: recoveredAt,
    recoveredBy: actorRef(auth.subject),
    caseEvidenceHash: caseEvidenceHash.toLowerCase(),
  };
  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: tableName,
          Item: walletGuard,
          ConditionExpression: 'attribute_not_exists(PK) OR investorId = :investorId',
          ExpressionAttributeValues: { ':investorId': investorId },
        },
      },
      { Put: { TableName: tableName, Item: binding } },
    ],
  }));
  return {
    investorId,
    wallet: replacementWallet,
    status: 'SUSPENDED',
    boundAt: recoveredAt,
  };
}

function emptyMovement(input, movementId, createdAt, auth, railKind = 'SQUADS_FIAT_FORWARD') {
  return assertMovementShape({
    ...movementKey(movementId),
    entityType: 'RWA_TREASURY_MOVEMENT',
    id: movementId,
    dealId: assertText('dealId', input.dealId, 128),
    milestoneIndex: input.milestoneIndex,
    status: 'PROPOSED',
    railKind,
    releasedUsdcBaseUnits: '0',
    grossUsdMinor: '0',
    netUsdMinor: '0',
    conversionRateE8: '0',
    providerFeesUsdMinor: '0',
    bankFeesUsdMinor: '0',
    beneficiaryEntityHash: assertHash('beneficiaryEntityHash', input.beneficiaryEntityHash),
    bankRouteHash: railKind === 'SQUADS_FIAT_FORWARD'
      ? assertHash('bankRouteHash', input.bankRouteHash)
      : null,
    createdBy: actorRef(auth.subject),
    createdAt,
    updatedAt: createdAt,
    version: 1,
    GSI1PK: `RWA#DEAL#${input.dealId}#TREASURY`,
    GSI1SK: `${String(input.milestoneIndex).padStart(4, '0')}#${createdAt}#${movementId}`,
  });
}

async function createFiatDisbursement(event, auth) {
  requireRole(auth, ['OPERATIONS', 'ADMIN', 'SUPER_ADMIN', 'TREASURY']);
  const input = event.arguments.input;
  if (!Number.isInteger(input.milestoneIndex) || input.milestoneIndex < 0 || input.milestoneIndex > 255) {
    throw new Error('milestoneIndex must be an integer from 0 through 255');
  }
  const beneficiaryEntityHash = assertHash(
    'beneficiaryEntityHash',
    input.beneficiaryEntityHash,
  );
  const deal = await getItem({ PK: `RWA#DEAL#${input.dealId}`, SK: 'META' });
  if (!deal) throw new Error('The indexed on-chain deal was not found');
  if (!['FUNDED', 'ACTIVE'].includes(deal.state)) {
    throw new Error('The deal must be funded or active before disbursement');
  }
  if (deal.beneficiaryEntityHash !== beneficiaryEntityHash) {
    throw new Error('Beneficiary does not match the immutable deal terms');
  }
  const railKind = deal.mseRailKind || 'SQUADS_FIAT_FORWARD';
  // The SWIFT/bank route is only meaningful for the Squads fiat-forward rail; a
  // direct-USDC MSE has no off-chain bank leg to validate against.
  if (railKind === 'SQUADS_FIAT_FORWARD') {
    const bankRouteHash = assertHash('bankRouteHash', input.bankRouteHash);
    if (deal.bankRouteHash !== bankRouteHash) {
      throw new Error('Bank route does not match the immutable approved route');
    }
  }
  const milestones = await queryIndex(
    'GSI1',
    'GSI1PK',
    `RWA#DEAL#${input.dealId}#MILESTONES`,
  );
  const milestone = milestones.find((item) => item.index === input.milestoneIndex);
  if (!milestone || milestone.status !== 'SCHEDULED') {
    throw new Error('A scheduled on-chain release milestone is required');
  }
  const existing = await queryIndex(
    'GSI1',
    'GSI1PK',
    `RWA#DEAL#${input.dealId}#TREASURY`,
  );
  if (existing.some((item) => item.milestoneIndex === input.milestoneIndex
      && !['FAILED', 'RETURNED'].includes(item.status))) {
    throw new Error('This milestone already has an active disbursement');
  }
  if (input.milestoneIndex > 0) {
    const preceding = existing.find(
      (item) => item.milestoneIndex === input.milestoneIndex - 1,
    );
    if (!preceding || preceding.status !== 'RECONCILED') {
      throw new Error('The preceding fiat disbursement must be bank-confirmed and reconciled');
    }
  }
  const id = crypto.randomUUID();
  const movement = {
    ...emptyMovement(input, id, nowIso(), auth, railKind),
    plannedReleaseBaseUnits: assertAmount(
      'milestone.amountBaseUnits',
      milestone.amountBaseUnits,
    ),
    milestoneGateAddress: milestone.gateAddress,
    milestoneGateRevision: milestone.gateRevision,
  };
  await documentClient.send(new PutCommand({
    TableName: tableName,
    Item: movement,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
  return movement;
}

async function saveMovement(previous, next, auth, action) {
  assertMovementShape(next);
  const timestamp = nowIso();
  const versioned = {
    ...next,
    updatedAt: timestamp,
    version: previous.version + 1,
  };
  const auditId = crypto.randomUUID();
  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: tableName,
          Item: versioned,
          ConditionExpression: '#version = :version AND #status = :status',
          ExpressionAttributeNames: { '#version': 'version', '#status': 'status' },
          ExpressionAttributeValues: {
            ':version': previous.version,
            ':status': previous.status,
          },
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: {
            PK: `RWA#MOVEMENT#${previous.id}`,
            SK: `AUDIT#${timestamp}#${auditId}`,
            entityType: 'RWA_TREASURY_AUDIT',
            movementId: previous.id,
            dealId: previous.dealId,
            action,
            fromStatus: previous.status,
            toStatus: versioned.status,
            actor: actorRef(auth.subject),
            createdAt: timestamp,
          },
          ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
        },
      },
    ],
  }));
  return versioned;
}

async function requireMovement(id) {
  assertText('movementId', id, 128);
  const movement = await getItem(movementKey(id));
  if (!movement) throw new Error('Treasury movement was not found');
  return movement;
}

async function approveFiatDisbursement(event, auth) {
  const { movementId, approvalRole } = event.arguments.input;
  if (!['TREASURY', 'RISK'].includes(approvalRole)) {
    throw new Error('approvalRole must be TREASURY or RISK');
  }
  requireRole(auth, [approvalRole, 'SUPER_ADMIN']);
  const movement = await requireMovement(movementId);
  if (movement.status !== 'PROPOSED') throw new Error('Only a proposed movement can be approved');
  const approver = actorRef(auth.subject);
  if (approvalRole === 'TREASURY' && movement.riskApprovedBy === approver) {
    throw new Error('Treasury and risk approvals must come from different people');
  }
  if (approvalRole === 'RISK' && movement.treasuryApprovedBy === approver) {
    throw new Error('Treasury and risk approvals must come from different people');
  }
  if (approvalRole === 'TREASURY' && movement.treasuryApprovedBy) {
    throw new Error('Treasury approval already exists');
  }
  if (approvalRole === 'RISK' && movement.riskApprovedBy) {
    throw new Error('Risk approval already exists');
  }
  const field = approvalRole === 'TREASURY' ? 'treasuryApprovedBy' : 'riskApprovedBy';
  const timeField = approvalRole === 'TREASURY' ? 'treasuryApprovedAt' : 'riskApprovedAt';
  const next = { ...movement, [field]: approver, [timeField]: nowIso() };
  if (next.treasuryApprovedBy && next.riskApprovedBy) next.status = 'APPROVED';
  return saveMovement(movement, next, auth, `${approvalRole}_APPROVED`);
}

async function markUsdcReleased(event, auth) {
  requireRole(auth, ['TREASURY', 'SUPER_ADMIN']);
  const { movementId, releasedUsdcBaseUnits, releaseSignature } = event.arguments.input;
  const movement = await requireMovement(movementId);
  if (movement.status !== 'APPROVED') throw new Error('Dual approval is required before USDC release');
  assertAmount('releasedUsdcBaseUnits', releasedUsdcBaseUnits);
  if (releasedUsdcBaseUnits === '0') throw new Error('Released USDC must be greater than zero');
  if (releasedUsdcBaseUnits !== movement.plannedReleaseBaseUnits) {
    throw new Error('Released USDC must exactly equal the scheduled milestone amount');
  }
  assertText('releaseSignature', releaseSignature, 128);
  return saveMovement(movement, {
    ...movement,
    status: 'USDC_RELEASED',
    releasedUsdcBaseUnits,
    releaseSignature,
    releasedAt: nowIso(),
  }, auth, 'USDC_RELEASED');
}

async function recordConversion(event, auth) {
  requireRole(auth, ['TREASURY', 'SUPER_ADMIN']);
  const input = event.arguments.input;
  const movement = await requireMovement(input.movementId);
  if (movement.railKind === 'DIRECT_USDC') {
    throw new Error('Direct-USDC MSE movements have no conversion stage');
  }
  if (movement.status !== 'USDC_RELEASED') throw new Error('USDC must be released before conversion');
  const gross = BigInt(assertAmount('grossUsdMinor', input.grossUsdMinor));
  const net = BigInt(assertAmount('netUsdMinor', input.netUsdMinor));
  const providerFees = BigInt(assertAmount('providerFeesUsdMinor', input.providerFeesUsdMinor));
  const bankFees = BigInt(assertAmount('bankFeesUsdMinor', input.bankFeesUsdMinor));
  assertAmount('conversionRateE8', input.conversionRateE8);
  if (gross === 0n || BigInt(input.conversionRateE8) === 0n) {
    throw new Error('Gross USD and conversion rate must be greater than zero');
  }
  if (net + providerFees + bankFees !== gross) {
    throw new Error('Net USD plus provider and bank fees must exactly equal gross USD');
  }
  return saveMovement(movement, {
    ...movement,
    status: 'CONVERTED',
    conversionProviderRefHash: assertHash(
      'conversionProviderRefHash',
      input.conversionProviderRefHash,
    ),
    grossUsdMinor: input.grossUsdMinor,
    netUsdMinor: input.netUsdMinor,
    conversionRateE8: input.conversionRateE8,
    providerFeesUsdMinor: input.providerFeesUsdMinor,
    bankFeesUsdMinor: input.bankFeesUsdMinor,
    providerEvidenceHash: assertHash('providerEvidenceHash', input.providerEvidenceHash),
    convertedAt: nowIso(),
  }, auth, 'CONVERSION_RECORDED');
}

async function recordSwiftConfirmation(event, auth) {
  requireRole(auth, ['OPERATIONS', 'ADMIN', 'SUPER_ADMIN']);
  const input = event.arguments.input;
  const movement = await requireMovement(input.movementId);
  if (movement.railKind === 'DIRECT_USDC') {
    throw new Error('Direct-USDC MSE movements have no SWIFT stage');
  }
  if (movement.status !== 'CONVERTED' && movement.status !== 'SWIFT_SENT') {
    throw new Error('Conversion must be recorded before SWIFT confirmation');
  }
  assertText('swiftUetr', input.swiftUetr, 128);
  if (!/^[0-9a-fA-F-]{32,36}$/.test(input.swiftUetr)) {
    throw new Error('swiftUetr must be a UUID-formatted UETR');
  }
  assertText('valueDate', input.valueDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.valueDate)) throw new Error('valueDate must be YYYY-MM-DD');
  return saveMovement(movement, {
    ...movement,
    status: 'BANK_CONFIRMED',
    swiftUetrHash: sha256(input.swiftUetr.toLowerCase()),
    valueDate: input.valueDate,
    bankConfirmationHash: assertHash('bankConfirmationHash', input.bankConfirmationHash),
    bankConfirmedAt: nowIso(),
  }, auth, 'BANK_CONFIRMED');
}

async function reconcileTreasuryMovement(event, auth) {
  requireRole(auth, ['RISK', 'ADMIN', 'SUPER_ADMIN']);
  const { movementId, reconciliationEvidenceHash } = event.arguments.input;
  const movement = await requireMovement(movementId);
  // The Squads fiat-forward rail must clear bank confirmation first; a direct-USDC
  // MSE movement reconciles straight from the finalized on-chain release.
  const requiredStatus = movement.railKind === 'DIRECT_USDC'
    ? 'USDC_RELEASED'
    : 'BANK_CONFIRMED';
  if (movement.status !== requiredStatus) {
    throw new Error(`Reconciliation requires the movement to be ${requiredStatus}`);
  }
  const reconciler = actorRef(auth.subject);
  if ([movement.treasuryApprovedBy, movement.riskApprovedBy].includes(reconciler)) {
    throw new Error('The final reviewer must be independent of the two release approvers');
  }
  return saveMovement(movement, {
    ...movement,
    status: 'RECONCILED',
    reconciliationEvidenceHash: assertHash(
      'reconciliationEvidenceHash',
      reconciliationEvidenceHash,
    ),
    reconciledBy: reconciler,
    reconciledAt: nowIso(),
  }, auth, 'RECONCILED');
}

async function recordFiatRepayment(event, auth) {
  requireRole(auth, ['TREASURY', 'OPERATIONS', 'ADMIN', 'SUPER_ADMIN']);
  const input = event.arguments.input;
  const id = crypto.randomUUID();
  const updatedAt = nowIso();
  const item = {
    ...repaymentKey(id),
    entityType: 'RWA_FIAT_REPAYMENT',
    id,
    dealId: assertText('dealId', input.dealId, 128),
    payerType: assertText('payerType', input.payerType, 64),
    fiatBankEvidenceHash: assertHash('fiatBankEvidenceHash', input.fiatBankEvidenceHash),
    grossUsdMinor: assertAmount('grossUsdMinor', input.grossUsdMinor),
    netUsdcBaseUnits: assertAmount('netUsdcBaseUnits', input.netUsdcBaseUnits),
    conversionProviderRefHash: assertHash(
      'conversionProviderRefHash',
      input.conversionProviderRefHash,
    ),
    status: 'FIAT_AND_CONVERSION_RECORDED',
    updatedAt,
    createdBy: actorRef(auth.subject),
    GSI1PK: `RWA#DEAL#${input.dealId}#REPAYMENT`,
    GSI1SK: `${updatedAt}#${id}`,
  };
  if (item.grossUsdMinor === '0' || item.netUsdcBaseUnits === '0') {
    throw new Error('Repayment amounts must be greater than zero');
  }
  await documentClient.send(new PutCommand({
    TableName: tableName,
    Item: item,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
  return item;
}

async function bindingFor(auth) {
  return getItem({ PK: `RWA#SUBJECT#${sha256(auth.subject)}`, SK: 'WALLET_BINDING' });
}

async function rwaEligibility(auth) {
  const binding = await bindingFor(auth);
  if (!binding) return null;
  const eligibility = await getItem({
    PK: `RWA#INVESTOR#${binding.investorId}`,
    SK: 'ELIGIBILITY',
  });
  if (eligibility) {
    return {
      ...eligibility,
      investorIdHash: eligibility.investorIdHash || sha256(binding.investorId),
    };
  }
  return {
    investorId: binding.investorId,
    investorIdHash: sha256(binding.investorId),
    wallet: binding.wallet,
    status: 'SUSPENDED',
    providerRefHash: sha256('not-yet-verified'),
    policyVersion: 'pending',
    validUntil: new Date(0).toISOString(),
  };
}

async function rwaPosition(event, auth) {
  const binding = await bindingFor(auth);
  if (!binding) return null;
  return getItem({
    PK: `RWA#DEAL#${assertText('dealId', event.arguments.dealId, 128)}`,
    SK: `POSITION#${binding.investorId}`,
  });
}

async function handler(event) {
  if (!tableName) throw new Error('TABLE_NAME is required');
  const auth = identity(event);
  const field = event?.info?.fieldName;

  if (field === 'createRwaWalletChallenge') return createRwaWalletChallenge(event, auth);
  if (field === 'bindRwaWallet') return bindRwaWallet(event, auth);
  if (field === 'recoverRwaWallet') return recoverRwaWallet(event, auth);
  if (field === 'createFiatDisbursement') return createFiatDisbursement(event, auth);
  if (field === 'approveFiatDisbursement') return approveFiatDisbursement(event, auth);
  if (field === 'markUsdcReleased') return markUsdcReleased(event, auth);
  if (field === 'recordConversion') return recordConversion(event, auth);
  if (field === 'recordSwiftConfirmation') return recordSwiftConfirmation(event, auth);
  if (field === 'recordFiatRepayment') return recordFiatRepayment(event, auth);
  if (field === 'reconcileTreasuryMovement') return reconcileTreasuryMovement(event, auth);

  if (field === 'rwaDeals') {
    return queryIndex('GSI1', 'GSI1PK', 'RWA#DEALS');
  }
  if (field === 'rwaDeal') {
    return getItem({
      PK: `RWA#DEAL#${assertText('dealId', event.arguments.dealId, 128)}`,
      SK: 'META',
    });
  }
  if (field === 'rwaEligibility') return rwaEligibility(auth);
  if (field === 'rwaPosition') return rwaPosition(event, auth);
  if (field === 'rwaMilestones') {
    return queryIndex(
      'GSI1',
      'GSI1PK',
      `RWA#DEAL#${assertText('dealId', event.arguments.dealId, 128)}#MILESTONES`,
    );
  }
  if (field === 'rwaTreasuryMovements') {
    return queryIndex(
      'GSI1',
      'GSI1PK',
      `RWA#DEAL#${assertText('dealId', event.arguments.dealId, 128)}#TREASURY`,
    );
  }
  if (field === 'rwaSettlement') {
    return getItem({
      PK: `RWA#DEAL#${assertText('dealId', event.arguments.dealId, 128)}`,
      SK: 'SETTLEMENT',
    });
  }
  if (field === 'rwaMseBeneficiaries') {
    return queryIndex('GSI1', 'GSI1PK', 'RWA#MSE_BENEFICIARIES');
  }
  throw new Error(`RWA resolver ${field || 'unknown'} is not implemented`);
}

module.exports = {
  handler,
  _test: {
    assertAmount,
    assertHash,
    challengeMessage,
    decodeBase58,
    verifyWalletSignature,
  },
};
