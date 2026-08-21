import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RwaStack } from '../lib/rwa-stack';

const baseProps = {
  stage: 'dev',
  domainTableName: 'turmi-dev-domain',
  userPoolId: 'us-east-1_TESTPOOL0',
  eventBusName: 'turmi-dev-domain-events',
};

describe('Turmi RWA tokenization stack', () => {
  const app = new cdk.App();
  const stack = new RwaStack(app, 'TestRwaStack', baseProps);
  const template = Template.fromStack(stack);

  test('owns the RWA plane and none of the platform resolvers', () => {
    template.resourceCountIs('AWS::AppSync::Resolver', 18);
    template.resourceCountIs('AWS::AppSync::GraphQLApi', 1);
    // The platform's own operations must never be redefined here — redeploying
    // this stack must be incapable of deleting them.
    for (const field of ['listUsers', 'listFarms', 'recordOracleTranche1Result']) {
      template.resourcePropertiesCountIs('AWS::AppSync::Resolver', { FieldName: field }, 0);
    }
  });

  test('adds only the RWA role groups to the imported user pool', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolGroup', 4);
    for (const groupName of ['TREASURY', 'RISK', 'COMPLIANCE', 'OPERATIONS']) {
      template.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: groupName });
    }
    // It imports the pool rather than creating one.
    template.resourceCountIs('AWS::Cognito::UserPool', 0);
  });

  test('retains RWA evidence in a versioned KMS-encrypted private bucket', () => {
    template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: Match.anyValue(),
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
  });

  test('ships the finalized indexer schedule disabled by default', () => {
    template.hasResourceProperties('AWS::Events::Rule', { State: 'DISABLED' });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Threshold: 1,
      EvaluationPeriods: 1,
    });
  });

  test('refuses to enable the indexer without a program id and an RPC source', () => {
    const bad = new cdk.App({ context: { rwaIndexerEnabled: 'true' } });
    expect(() => new RwaStack(bad, 'BadRwaStack', baseProps)).toThrow(/rwaVaultProgramId|rwaRpcUrl/);
  });
});
