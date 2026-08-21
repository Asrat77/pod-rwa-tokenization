import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as path from 'path';
import { Construct } from 'constructs';

/**
 * Properties identifying the already-deployed platform Foundation stack.
 *
 * These are imported by name rather than by CloudFormation export so that this
 * stack never takes an ownership dependency on Foundation. Foundation is
 * deployed from a source tree this branch does not contain; adding an export
 * dependency would require changing it.
 */
export interface RwaStackProps extends cdk.StackProps {
  readonly stage: string;
  /** Single-table domain store owned by Foundation, e.g. `turmi-dev-domain`. */
  readonly domainTableName: string;
  /** Cognito user pool owned by Foundation. */
  readonly userPoolId: string;
  /** Domain event bus owned by Foundation, e.g. `turmi-dev-domain-events`. */
  readonly eventBusName: string;
  /** Solana RPC endpoint; the secret is resolved at runtime, never baked in. */
  readonly solanaRpcSecretName?: string;
}

/**
 * RWA tokenization plane.
 *
 * Deployed as a separate stack so it can ship without modifying the platform
 * Foundation stack, whose AppSync schema and 72 resolvers come from a source
 * tree this branch does not have. Deploying the RWA resolvers *into* Foundation
 * from here would delete every resolver missing from this branch.
 *
 * The two stacks stay integrated through shared state, not shared deployment:
 * the same DynamoDB table, the same Cognito user pool, and the same event bus.
 */
export class RwaStack extends cdk.Stack {
  public readonly api: appsync.GraphqlApi;

  constructor(scope: Construct, id: string, props: RwaStackProps) {
    super(scope, id, props);
    const { stage } = props;

    // ---- imported from Foundation (read/write, never created here) ----
    const domainTable = ddb.Table.fromTableName(this, 'DomainTable', props.domainTableName);
    const userPool = cognito.UserPool.fromUserPoolId(this, 'UserPool', props.userPoolId);
    const eventBus = events.EventBus.fromEventBusName(this, 'DomainEventBus', props.eventBusName);

    // ---- RWA-owned: evidence at rest ----
    // Bank, provider, UETR and identity artifacts are more sensitive than the
    // platform's general evidence bucket and get their own key and retention.
    const evidenceKey = new kms.Key(this, 'RwaEvidenceKey', {
      alias: `alias/turmi-${stage}-rwa-evidence`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      description: 'RWA bank, provider, UETR and identity evidence',
    });

    const evidenceBucket = new s3.Bucket(this, 'RwaEvidenceBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: evidenceKey,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---- RWA-owned: role groups, added alongside Foundation's existing roles ----
    // Foundation already defines SUPER_ADMIN, ADMIN, AGENT, MSE, FINANCIER,
    // FARMER and VET. These four add treasury separation of duties and must not
    // collide with those names.
    for (const groupName of ['TREASURY', 'RISK', 'COMPLIANCE', 'OPERATIONS']) {
      new cognito.CfnUserPoolGroup(this, `${groupName}Group`, {
        userPoolId: props.userPoolId,
        groupName,
        description: `RWA ${groupName.toLowerCase()} role`,
      });
    }

    // ---- RWA-owned: GraphQL surface ----
    // A second AppSync API, authorised by the *same* user pool, so a single
    // Cognito session works against both endpoints.
    this.api = new appsync.GraphqlApi(this, 'RwaGraphqlApi', {
      name: `turmi-${stage}-rwa`,
      definition: appsync.Definition.fromFile(path.join(__dirname, '..', 'graphql', 'rwa.graphql')),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: { userPool },
        },
        additionalAuthorizationModes: [{ authorizationType: appsync.AuthorizationType.IAM }],
      },
      logConfig: { fieldLogLevel: appsync.FieldLogLevel.ERROR },
    });

    const apiHandler = new lambda.Function(this, 'RwaApiHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'rwa-api')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      logGroup: new logs.LogGroup(this, 'RwaApiLogGroup', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        STAGE: stage,
        TABLE_NAME: props.domainTableName,
        USER_POOL_ID: props.userPoolId,
        EVENT_BUS_NAME: props.eventBusName,
        EVIDENCE_BUCKET_NAME: evidenceBucket.bucketName,
      },
    });
    domainTable.grantReadWriteData(apiHandler);
    evidenceBucket.grantReadWrite(apiHandler);
    evidenceKey.grantEncryptDecrypt(apiHandler);
    eventBus.grantPutEventsTo(apiHandler);

    const dataSource = this.api.addLambdaDataSource('RwaDataSource', apiHandler);

    const queries = [
      'rwaDeals', 'rwaDeal', 'rwaEligibility', 'rwaPosition',
      'rwaMilestones', 'rwaTreasuryMovements', 'rwaSettlement', 'rwaMseBeneficiaries',
    ];
    const mutations = [
      'createRwaWalletChallenge', 'bindRwaWallet', 'recoverRwaWallet',
      'createFiatDisbursement', 'approveFiatDisbursement', 'markUsdcReleased',
      'recordConversion', 'recordSwiftConfirmation', 'recordFiatRepayment',
      'reconcileTreasuryMovement',
    ];
    for (const fieldName of queries) {
      dataSource.createResolver(`${fieldName}Resolver`, { typeName: 'Query', fieldName });
    }
    for (const fieldName of mutations) {
      dataSource.createResolver(`${fieldName}Resolver`, { typeName: 'Mutation', fieldName });
    }

    // ---- RWA-owned: chain mirror ----
    // Reads finalized Solana state and writes RWA# items into the shared table.
    // The chain stays authoritative; this is a projection.
    const indexerHandler = new lambda.Function(this, 'RwaIndexerHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'rwa-indexer')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      reservedConcurrentExecutions: 1,
      logGroup: new logs.LogGroup(this, 'RwaIndexerLogGroup', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        STAGE: stage,
        TABLE_NAME: props.domainTableName,
        RWA_COMMITMENT: 'finalized',
        ...(props.solanaRpcSecretName ? { SOLANA_RPC_SECRET_NAME: props.solanaRpcSecretName } : {}),
      },
    });
    domainTable.grantReadWriteData(indexerHandler);

    // Indexer enablement is deliberately opt-in and validated up front: an enabled
    // indexer that cannot reach a program or an RPC endpoint would silently write an
    // empty mirror, and the mirror is what operations reads.
    const indexerEnabledContext = String(
      this.node.tryGetContext('rwaIndexerEnabled') ?? 'false',
    ).toLowerCase();
    if (!['true', 'false'].includes(indexerEnabledContext)) {
      throw new Error('rwaIndexerEnabled must be true or false');
    }
    const indexerEnabled = indexerEnabledContext === 'true';
    const scheduleMinutes = Number(this.node.tryGetContext('rwaIndexerScheduleMinutes') ?? 5);
    if (!Number.isInteger(scheduleMinutes) || scheduleMinutes < 1 || scheduleMinutes > 60) {
      throw new Error('rwaIndexerScheduleMinutes must be an integer from 1 to 60');
    }
    const vaultProgramIdContext = this.node.tryGetContext('rwaVaultProgramId');
    const rpcUrlContext = this.node.tryGetContext('rwaRpcUrl');
    const rpcSecretArn = this.node.tryGetContext('rwaRpcSecretArn');
    if (indexerEnabled && !vaultProgramIdContext) {
      throw new Error('An enabled RWA indexer requires rwaVaultProgramId context');
    }
    if (indexerEnabled && !rpcUrlContext && !rpcSecretArn && !props.solanaRpcSecretName) {
      throw new Error('An enabled RWA indexer requires rwaRpcUrl or rwaRpcSecretArn context');
    }
    if (rpcUrlContext && rpcSecretArn) {
      throw new Error('Set exactly one of rwaRpcUrl or rwaRpcSecretArn context');
    }

    // Disabled until a dry run is verified against deployed programs.
    const schedule = new events.Rule(this, 'RwaIndexerSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(scheduleMinutes)),
      enabled: indexerEnabled,
      targets: [new targets.LambdaFunction(indexerHandler)],
    });

    new cloudwatch.Alarm(this, 'RwaIndexerErrorAlarm', {
      metric: indexerHandler.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cdk.CfnOutput(this, 'RwaGraphqlUrl', { value: this.api.graphqlUrl });
    new cdk.CfnOutput(this, 'RwaEvidenceBucketName', { value: evidenceBucket.bucketName });
    new cdk.CfnOutput(this, 'RwaIndexerScheduleName', { value: schedule.ruleName });
    new cdk.CfnOutput(this, 'RwaSharedTable', { value: props.domainTableName });

    cdk.Tags.of(this).add('Application', 'TurmiRwa');
    cdk.Tags.of(this).add('Environment', stage);
  }
}
