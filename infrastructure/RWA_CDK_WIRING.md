# RWA CDK wiring (reference extract)

These lines live in `infrastructure/lib/infrastructure-stack.ts` in the upstream
`proofofdirt/PODAPPSAWSNative` repo, interleaved with the shared Foundation stack.
They could not be extracted cleanly because the file also defines the farm, livestock,
contract and oracle resources owned by the wider platform.

Reproduce by grepping the upstream file for `Rwa`. Line numbers are as of commit
`21702fd` (merge of PR #5, 2026-08-14).

```ts
/*   33*/     const rwaClusterGenesis =
/*   34*/       this.node.tryGetContext('rwaClusterGenesis')
// ---- gap: lines 35-35 ----
/*   36*/     const rwaVaultProgramIdContext = this.node.tryGetContext('rwaVaultProgramId');
/*   37*/     const rwaVaultProgramId =
/*   38*/       rwaVaultProgramIdContext
// ---- gap: lines 39-39 ----
/*   40*/     const rwaRpcUrlContext = this.node.tryGetContext('rwaRpcUrl');
/*   41*/     const rwaRpcSecretArn = this.node.tryGetContext('rwaRpcSecretArn');
/*   42*/     const rwaIndexerEnabledContext = String(
/*   43*/       this.node.tryGetContext('rwaIndexerEnabled') ?? 'false',
// ---- gap: lines 44-44 ----
/*   45*/     if (!['true', 'false'].includes(rwaIndexerEnabledContext)) {
/*   46*/       throw new Error('rwaIndexerEnabled must be true or false');
// ---- gap: lines 47-47 ----
/*   48*/     const rwaIndexerEnabled = rwaIndexerEnabledContext === 'true';
/*   49*/     const rwaIndexerScheduleMinutes = Number(
/*   50*/       this.node.tryGetContext('rwaIndexerScheduleMinutes') ?? 5,
// ---- gap: lines 51-53 ----
/*   54*/       !Number.isInteger(rwaIndexerScheduleMinutes)
/*   55*/       || rwaIndexerScheduleMinutes < 1
/*   56*/       || rwaIndexerScheduleMinutes > 60
// ---- gap: lines 57-57 ----
/*   58*/       throw new Error('rwaIndexerScheduleMinutes must be an integer from 1 to 60');
// ---- gap: lines 59-59 ----
/*   60*/     if (rwaIndexerEnabled && !rwaVaultProgramIdContext) {
/*   61*/       throw new Error('An enabled RWA indexer requires rwaVaultProgramId context');
// ---- gap: lines 62-62 ----
/*   63*/     if (rwaIndexerEnabled && !rwaRpcUrlContext && !rwaRpcSecretArn) {
// ---- gap: lines 64-64 ----
/*   65*/         'An enabled RWA indexer requires rwaRpcUrl or rwaRpcSecretArn context',
// ---- gap: lines 66-67 ----
/*   68*/     if (rwaRpcUrlContext && rwaRpcSecretArn) {
// ---- gap: lines 69-69 ----
/*   70*/         'Set exactly one of rwaRpcUrl or rwaRpcSecretArn context',
// ---- gap: lines 71-198 ----
/*  199*/     const rwaEvidenceKey = new kms.Key(this, 'RwaEvidenceKey', {
/*  200*/       alias: `alias/turmi-${stage}-rwa-evidence`,
// ---- gap: lines 201-204 ----
/*  205*/     const rwaEvidenceBucket = new s3.Bucket(this, 'RwaEvidenceBucket', {
// ---- gap: lines 206-207 ----
/*  208*/       encryptionKey: rwaEvidenceKey,
// ---- gap: lines 209-233 ----
/*  234*/         id: 'RwaInvestor',
// ---- gap: lines 235-235 ----
/*  236*/         source: path.join(__dirname, '../../apps/rwa-investor/dist'),
// ---- gap: lines 237-423 ----
/*  424*/     ScanIndexForward: false
// ---- gap: lines 425-821 ----
/*  822*/     ScanIndexForward: false
// ---- gap: lines 823-900 ----
/*  901*/       ScanIndexForward: false,
// ---- gap: lines 902-986 ----
/*  987*/     const response = await db.send(new QueryCommand({ TableName: process.env.TABLE_NAME, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :key', ExpressionAttributeValues: { ':key': 'FARMER' }, ScanIndexForward: false }));
// ---- gap: lines 988-992 ----
/*  993*/     const farmResponse = await db.send(new QueryCommand({ TableName: process.env.TABLE_NAME, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :key', ExpressionAttributeValues: { ':key': 'FARM' }, ScanIndexForward: false }));
// ---- gap: lines 994-998 ----
/*  999*/     db.send(new QueryCommand({ TableName: process.env.TABLE_NAME, IndexName: 'GSI2', KeyConditionExpression: 'GSI2PK = :key', ExpressionAttributeValues: { ':key': 'AGENT#' + sub }, ScanIndexForward: false })),
/* 1000*/     db.send(new QueryCommand({ TableName: process.env.TABLE_NAME, IndexName: 'GSI3', KeyConditionExpression: 'GSI3PK = :key AND begins_with(GSI3SK, :kind)', ExpressionAttributeValues: { ':key': 'CREATOR#' + sub, ':kind': 'FARMER#' }, ScanIndexForward: false }))
// ---- gap: lines 1001-1129 ----
/* 1130*/     const response = await db.send(new QueryCommand({ TableName: process.env.TABLE_NAME, IndexName: 'GSI2', KeyConditionExpression: 'GSI2PK = :key', ExpressionAttributeValues: { ':key': 'FARMER#' + farmerId }, ScanIndexForward: false }));
// ---- gap: lines 1131-1135 ----
/* 1136*/     const response = await db.send(new QueryCommand({ TableName: process.env.TABLE_NAME, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :key', ExpressionAttributeValues: { ':key': 'FARM' }, ScanIndexForward: false }));
// ---- gap: lines 1137-1139 ----
/* 1140*/     const response = await db.send(new QueryCommand({ TableName: process.env.TABLE_NAME, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :key', ExpressionAttributeValues: { ':key': 'FARM' }, ScanIndexForward: false }));
// ---- gap: lines 1141-1143 ----
/* 1144*/     db.send(new QueryCommand({ TableName: process.env.TABLE_NAME, IndexName: 'GSI2', KeyConditionExpression: 'GSI2PK = :key', ExpressionAttributeValues: { ':key': 'AGENT_FARM#' + sub }, ScanIndexForward: false })),
/* 1145*/     db.send(new QueryCommand({ TableName: process.env.TABLE_NAME, IndexName: 'GSI3', KeyConditionExpression: 'GSI3PK = :key AND begins_with(GSI3SK, :kind)', ExpressionAttributeValues: { ':key': 'CREATOR#' + sub, ':kind': 'FARM#' }, ScanIndexForward: false }))
// ---- gap: lines 1146-1264 ----
/* 1265*/     ScanIndexForward: false
// ---- gap: lines 1266-1279 ----
/* 1280*/     ScanIndexForward: false
// ---- gap: lines 1281-1537 ----
/* 1538*/     ScanIndexForward: false
// ---- gap: lines 1539-1565 ----
/* 1566*/   const response = await db.send(new QueryCommand({ TableName: process.env.TABLE_NAME, IndexName: 'GSI2', KeyConditionExpression: 'GSI2PK = :farm AND begins_with(GSI2SK, :kind)', ExpressionAttributeValues: { ':farm': 'FARM#' + event.arguments.farmId, ':kind': 'CONTRACT#' }, ScanIndexForward: false }));
// ---- gap: lines 1567-1582 ----
/* 1583*/   const response = await db.send(new QueryCommand({ TableName: process.env.TABLE_NAME, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :key', ExpressionAttributeValues: { ':key': 'CONTRACT#SUBMITTED_FOR_APPROVAL' }, ScanIndexForward: false }));
// ---- gap: lines 1584-1616 ----
/* 1617*/   const existing = await db.send(new QueryCommand({ TableName: process.env.TABLE_NAME, IndexName: 'GSI2', KeyConditionExpression: 'GSI2PK = :farm AND begins_with(GSI2SK, :kind)', ExpressionAttributeValues: { ':farm': 'FARM#' + farm.id, ':kind': 'CONTRACT#' }, ScanIndexForward: false }));
// ---- gap: lines 1618-1672 ----
/* 1673*/   const response = await db.send(new QueryCommand({ TableName: process.env.TABLE_NAME, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :key', ExpressionAttributeValues: { ':key': 'CONTRACT#APPROVED' }, ScanIndexForward: false }));
// ---- gap: lines 1674-1686 ----
/* 1687*/     ScanIndexForward: false
// ---- gap: lines 1688-1699 ----
/* 1700*/     ScanIndexForward: false
// ---- gap: lines 1701-1840 ----
/* 1841*/   const response = await db.send(new QueryCommand({ TableName: process.env.TABLE_NAME, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :key', ExpressionAttributeValues: { ':key': 'ACTIVITY_DEFINITION' }, ScanIndexForward: true }));
// ---- gap: lines 1842-1961 ----
/* 1962*/   const response = await db.send(new QueryCommand({ TableName: process.env.TABLE_NAME, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :key', ExpressionAttributeValues: { ':key': 'SEASONAL_PRICING' }, ScanIndexForward: true }));
// ---- gap: lines 1963-2118 ----
/* 2119*/   const response = await db.send(new QueryCommand({ TableName: process.env.TABLE_NAME, IndexName: 'GSI2', KeyConditionExpression: 'GSI2PK = :farm AND begins_with(GSI2SK, :kind)', ExpressionAttributeValues: { ':farm': 'FARM#' + event.arguments.farmId, ':kind': 'BATCH#' }, ScanIndexForward: false }));
// ---- gap: lines 2120-2169 ----
/* 2170*/   const response = await db.send(new QueryCommand({ TableName: process.env.TABLE_NAME, IndexName: 'GSI2', KeyConditionExpression: 'GSI2PK = :farm AND begins_with(GSI2SK, :kind)', ExpressionAttributeValues: { ':farm': 'FARM#' + event.arguments.farmId, ':kind': 'ACTIVITY#' }, ScanIndexForward: false }));
// ---- gap: lines 2171-2181 ----
/* 2182*/   const contracts = await db.send(new QueryCommand({ TableName: process.env.TABLE_NAME, IndexName: 'GSI2', KeyConditionExpression: 'GSI2PK = :farm AND begins_with(GSI2SK, :kind)', ExpressionAttributeValues: { ':farm': 'FARM#' + farm.id, ':kind': 'CONTRACT#' }, ScanIndexForward: false }));
// ---- gap: lines 2183-2361 ----
/* 2362*/     const rwaApiLogGroup = new logs.LogGroup(this, 'RwaApiLogGroup', {
/* 2363*/       logGroupName: `/aws/lambda/turmi-${stage}-rwa-api`,
// ---- gap: lines 2364-2366 ----
/* 2367*/     const rwaApiHandler = new lambda.Function(this, 'RwaApiHandler', {
/* 2368*/       functionName: `turmi-${stage}-rwa-api`,
// ---- gap: lines 2369-2370 ----
/* 2371*/       code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/rwa-api')),
// ---- gap: lines 2372-2374 ----
/* 2375*/       logGroup: rwaApiLogGroup,
// ---- gap: lines 2376-2378 ----
/* 2379*/           this.node.tryGetContext('rwaChallengeDomain') ?? `rwa.${stage}.turmi.example`,
/* 2380*/         RWA_CLUSTER_GENESIS: rwaClusterGenesis,
/* 2381*/         RWA_PROGRAM_ID: rwaVaultProgramId,
// ---- gap: lines 2382-2383 ----
/* 2384*/     domainTable.grantReadWriteData(rwaApiHandler);
// ---- gap: lines 2385-2385 ----
/* 2386*/     const rwaIndexerLogGroup = new logs.LogGroup(this, 'RwaIndexerLogGroup', {
/* 2387*/       logGroupName: `/aws/lambda/turmi-${stage}-rwa-indexer`,
// ---- gap: lines 2388-2390 ----
/* 2391*/     const rwaIndexerEnvironment: Record<string, string> = {
// ---- gap: lines 2392-2392 ----
/* 2393*/       RWA_CLUSTER_GENESIS: rwaClusterGenesis,
/* 2394*/       RWA_PROGRAM_ID: rwaVaultProgramId,
// ---- gap: lines 2395-2401 ----
/* 2402*/     if (rwaRpcSecretArn) {
/* 2403*/       rwaIndexerEnvironment.SOLANA_RPC_SECRET_ARN = rwaRpcSecretArn;
// ---- gap: lines 2404-2404 ----
/* 2405*/       rwaIndexerEnvironment.SOLANA_RPC_URL =
/* 2406*/         rwaRpcUrlContext ?? 'https://api.devnet.solana.com';
// ---- gap: lines 2407-2408 ----
/* 2409*/     const rwaIndexerHandler = new lambda.Function(this, 'RwaIndexerHandler', {
/* 2410*/       functionName: `turmi-${stage}-rwa-indexer`,
// ---- gap: lines 2411-2412 ----
/* 2413*/       code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/rwa-indexer')),
// ---- gap: lines 2414-2417 ----
/* 2418*/       logGroup: rwaIndexerLogGroup,
/* 2419*/       environment: rwaIndexerEnvironment,
// ---- gap: lines 2420-2420 ----
/* 2421*/     domainTable.grantReadWriteData(rwaIndexerHandler);
/* 2422*/     if (rwaRpcSecretArn) {
// ---- gap: lines 2423-2424 ----
/* 2425*/         'RwaRpcSecret',
/* 2426*/         rwaRpcSecretArn,
/* 2427*/       ).grantRead(rwaIndexerHandler);
// ---- gap: lines 2428-2429 ----
/* 2430*/     const rwaIndexerSchedule = new events.Rule(this, 'RwaIndexerSchedule', {
/* 2431*/       ruleName: `turmi-${stage}-rwa-indexer-schedule`,
// ---- gap: lines 2432-2432 ----
/* 2433*/       enabled: rwaIndexerEnabled,
// ---- gap: lines 2434-2434 ----
/* 2435*/         cdk.Duration.minutes(rwaIndexerScheduleMinutes),
// ---- gap: lines 2436-2437 ----
/* 2438*/     rwaIndexerSchedule.addTarget(new eventTargets.LambdaFunction(rwaIndexerHandler, {
// ---- gap: lines 2439-2442 ----
/* 2443*/     const rwaIndexerErrorAlarm = new cloudwatch.Alarm(this, 'RwaIndexerErrorAlarm', {
/* 2444*/       alarmName: `turmi-${stage}-rwa-indexer-errors`,
// ---- gap: lines 2445-2445 ----
/* 2446*/       metric: rwaIndexerHandler.metricErrors({
// ---- gap: lines 2447-2483 ----
/* 2484*/     const rwaDataSource = graphqlApi.addLambdaDataSource(
/* 2485*/       'RwaDataSource',
/* 2486*/       rwaApiHandler,
// ---- gap: lines 2487-2550 ----
/* 2551*/       'rwaDeals',
/* 2552*/       'rwaDeal',
/* 2553*/       'rwaEligibility',
/* 2554*/       'rwaPosition',
/* 2555*/       'rwaMilestones',
/* 2556*/       'rwaTreasuryMovements',
/* 2557*/       'rwaSettlement',
/* 2558*/       'rwaMseBeneficiaries',
// ---- gap: lines 2559-2559 ----
/* 2560*/       rwaDataSource.createResolver(`${fieldName}Resolver`, {
// ---- gap: lines 2561-2565 ----
/* 2566*/       'createRwaWalletChallenge',
/* 2567*/       'bindRwaWallet',
/* 2568*/       'recoverRwaWallet',
// ---- gap: lines 2569-2576 ----
/* 2577*/       rwaDataSource.createResolver(`${fieldName}Resolver`, {
// ---- gap: lines 2578-2613 ----
/* 2614*/     new cdk.CfnOutput(this, 'RwaInvestorWebUrl', {
// ---- gap: lines 2615-2616 ----
/* 2617*/     new cdk.CfnOutput(this, 'RwaInvestorWebDistributionId', {
// ---- gap: lines 2618-2619 ----
/* 2620*/     new cdk.CfnOutput(this, 'RwaInvestorWebBucketName', {
// ---- gap: lines 2621-2622 ----
/* 2623*/     new cdk.CfnOutput(this, 'RwaApiFunctionName', {
/* 2624*/       value: rwaApiHandler.functionName,
// ---- gap: lines 2625-2625 ----
/* 2626*/     new cdk.CfnOutput(this, 'RwaEvidenceBucketName', {
/* 2627*/       value: rwaEvidenceBucket.bucketName,
// ---- gap: lines 2628-2628 ----
/* 2629*/     new cdk.CfnOutput(this, 'RwaEvidenceKeyArn', {
/* 2630*/       value: rwaEvidenceKey.keyArn,
// ---- gap: lines 2631-2631 ----
/* 2632*/     new cdk.CfnOutput(this, 'RwaIndexerFunctionName', {
/* 2633*/       value: rwaIndexerHandler.functionName,
// ---- gap: lines 2634-2634 ----
/* 2635*/     new cdk.CfnOutput(this, 'RwaIndexerScheduleName', {
/* 2636*/       value: rwaIndexerSchedule.ruleName,
// ---- gap: lines 2637-2637 ----
/* 2638*/     new cdk.CfnOutput(this, 'RwaIndexerErrorAlarmName', {
/* 2639*/       value: rwaIndexerErrorAlarm.alarmName,
// ---- gap: lines 2640-2640 ----
/* 2641*/     new cdk.CfnOutput(this, 'RwaClusterGenesis', {
/* 2642*/       value: rwaClusterGenesis,
// ---- gap: lines 2643-2643 ----
/* 2644*/     new cdk.CfnOutput(this, 'RwaVaultProgramId', {
/* 2645*/       value: rwaVaultProgramId,
```
