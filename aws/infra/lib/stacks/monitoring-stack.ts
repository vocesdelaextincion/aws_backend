import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { DatabaseStack } from './database-stack';
import { AuthStack } from './auth-stack';
import { StorageStack } from './storage-stack';
import { ApiStack } from './api-stack';

export interface MonitoringStackProps extends cdk.StackProps {
  appEnv: string;
  databaseStack: DatabaseStack;
  authStack: AuthStack;
  storageStack: StorageStack;
  apiStack: ApiStack;
  // Email address to receive alarm notifications. Required in prod.
  alertEmail?: string;
}

export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const isProd = props.appEnv === 'prod';

    // -------------------------------------------------------------------------
    // SSM Parameter Store
    // Write key config values so scripts, admin tools, and CI jobs can look
    // them up without parsing CloudFormation outputs or hardcoding ARNs.
    // -------------------------------------------------------------------------

    const ssmPrefix = `/voces/${props.appEnv}`;

    new ssm.StringParameter(this, 'SsmUserPoolId', {
      parameterName: `${ssmPrefix}/cognito/user-pool-id`,
      stringValue: props.authStack.userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new ssm.StringParameter(this, 'SsmUserPoolClientId', {
      parameterName: `${ssmPrefix}/cognito/user-pool-client-id`,
      stringValue: props.authStack.userPoolClient.userPoolClientId,
      description: 'Cognito App Client ID',
    });

    new ssm.StringParameter(this, 'SsmBucketName', {
      parameterName: `${ssmPrefix}/s3/bucket-name`,
      stringValue: props.storageStack.bucket.bucketName,
      description: 'S3 recordings bucket name',
    });

    new ssm.StringParameter(this, 'SsmTableName', {
      parameterName: `${ssmPrefix}/dynamodb/table-name`,
      stringValue: props.databaseStack.table.tableName,
      description: 'DynamoDB main table name',
    });

    // -------------------------------------------------------------------------
    // SNS Alarm Topic (prod only)
    // All CloudWatch alarms publish to this topic. Subscribe additional
    // endpoints (Slack webhook Lambda, PagerDuty, etc.) here in the future.
    // -------------------------------------------------------------------------

    if (!isProd) return; // Everything below is prod-only.

    if (!props.alertEmail) {
      throw new Error('alertEmail is required for prod monitoring stack');
    }

    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `voces-${props.appEnv}-alarms`,
      displayName: 'Voces de la Extinción — Infrastructure Alarms',
    });

    alarmTopic.addSubscription(
      new sns_subscriptions.EmailSubscription(props.alertEmail),
    );

    const alarmAction = new cw_actions.SnsAction(alarmTopic);

    // -------------------------------------------------------------------------
    // Helper: create a standard Lambda error alarm
    // -------------------------------------------------------------------------

    const lambdaErrorAlarm = (
      id: string,
      fn: cdk.aws_lambda.IFunction,
      fnName: string,
    ) =>
      new cloudwatch.Alarm(this, id, {
        alarmName: `voces-${props.appEnv}-${fnName}-errors`,
        alarmDescription: `Lambda ${fnName} error rate > 5 in 5 minutes`,
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(alarmAction);

    const lambdaThrottleAlarm = (
      id: string,
      fn: cdk.aws_lambda.IFunction,
      fnName: string,
    ) =>
      new cloudwatch.Alarm(this, id, {
        alarmName: `voces-${props.appEnv}-${fnName}-throttles`,
        alarmDescription: `Lambda ${fnName} is being throttled`,
        metric: fn.metricThrottles({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(alarmAction);

    // -------------------------------------------------------------------------
    // Lambda Alarms — errors and throttles for all 6 functions
    // -------------------------------------------------------------------------

    const fns: [string, cdk.aws_lambda.IFunction, string][] = [
      ['AuthErrors',       props.apiStack.authFn,       'auth'],
      ['UsersErrors',      props.apiStack.usersFn,      'users'],
      ['RecordingsErrors', props.apiStack.recordingsFn, 'recordings'],
      ['TagsErrors',       props.apiStack.tagsFn,       'tags'],
      ['AdminErrors',      props.apiStack.adminFn,      'admin'],
      ['MetricsErrors',    props.apiStack.metricsFn,    'metrics'],
    ];

    for (const [id, fn, name] of fns) {
      lambdaErrorAlarm(id, fn, name);
      lambdaThrottleAlarm(`${id.replace('Errors', 'Throttles')}`, fn, name);
    }

    // -------------------------------------------------------------------------
    // API Gateway Alarm — 5xx server errors
    // Uses raw CloudWatch metric because HttpApi doesn't expose L2 metric helpers.
    // -------------------------------------------------------------------------

    new cloudwatch.Alarm(this, 'ApiGw5xx', {
      alarmName: `voces-${props.appEnv}-apigw-5xx`,
      alarmDescription: 'API Gateway server error rate > 10 in 5 minutes',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5xx',
        dimensionsMap: {
          ApiId: props.apiStack.api.apiId,
          Stage: '$default',
        },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // -------------------------------------------------------------------------
    // DynamoDB Alarms — system errors and throttled requests
    // On-demand mode auto-scales but can still throttle under extreme burst.
    // -------------------------------------------------------------------------

    new cloudwatch.Alarm(this, 'DdbSystemErrors', {
      alarmName: `voces-${props.appEnv}-ddb-system-errors`,
      alarmDescription: 'DynamoDB system errors detected',
      metric: props.databaseStack.table.metricSystemErrorsForOperations({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    new cloudwatch.Alarm(this, 'DdbThrottles', {
      alarmName: `voces-${props.appEnv}-ddb-throttles`,
      alarmDescription: 'DynamoDB throttled requests detected',
      metric: props.databaseStack.table.metricThrottledRequestsForOperations({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // -------------------------------------------------------------------------
    // CloudWatch Dashboard (prod only)
    // Single pane of glass: API traffic, Lambda health, DynamoDB performance.
    // -------------------------------------------------------------------------

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `voces-${props.appEnv}`,
    });

    // Row 1: API Gateway traffic
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Gateway — Request Count',
        width: 12,
        left: [new cloudwatch.Metric({
          namespace: 'AWS/ApiGateway',
          metricName: 'Count',
          dimensionsMap: { ApiId: props.apiStack.api.apiId, Stage: '$default' },
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
          label: 'Requests',
        })],
      }),
      new cloudwatch.GraphWidget({
        title: 'API Gateway — Latency (p99)',
        width: 12,
        left: [new cloudwatch.Metric({
          namespace: 'AWS/ApiGateway',
          metricName: 'Latency',
          dimensionsMap: { ApiId: props.apiStack.api.apiId, Stage: '$default' },
          period: cdk.Duration.minutes(5),
          statistic: 'p99',
          label: 'p99 Latency (ms)',
        })],
      }),
    );

    // Row 2: Lambda invocations and errors
    const lambdaInvocations = fns.map(([, fn, name]) =>
      fn.metricInvocations({ period: cdk.Duration.minutes(5), statistic: 'Sum', label: name }),
    );
    const lambdaErrors = fns.map(([, fn, name]) =>
      fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum', label: name }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda — Invocations',
        width: 12,
        left: lambdaInvocations,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda — Errors',
        width: 12,
        left: lambdaErrors,
      }),
    );

    // Row 3: DynamoDB
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DynamoDB — Consumed Capacity',
        width: 12,
        left: [
          props.databaseStack.table.metricConsumedReadCapacityUnits({ period: cdk.Duration.minutes(5), label: 'Read CU' }),
          props.databaseStack.table.metricConsumedWriteCapacityUnits({ period: cdk.Duration.minutes(5), label: 'Write CU' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'DynamoDB — Throttled Requests',
        width: 12,
        left: [
          props.databaseStack.table.metricThrottledRequestsForOperations({ period: cdk.Duration.minutes(5) }),
        ],
      }),
    );
  }
}
