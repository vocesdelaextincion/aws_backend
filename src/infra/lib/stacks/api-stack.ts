import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';
import { DatabaseStack } from './database-stack';
import { AuthStack } from './auth-stack';
import { StorageStack } from './storage-stack';
import { EmailStack } from './email-stack';

export interface ApiStackProps extends cdk.StackProps {
  appEnv: string;
  databaseStack: DatabaseStack;
  authStack: AuthStack;
  storageStack: StorageStack;
  emailStack: EmailStack;
}

export class ApiStack extends cdk.Stack {
  // Exposed so MonitoringStack can create alarms and the dashboard without
  // needing to re-declare the functions or duplicate ARNs.
  public readonly authFn: NodejsFunction;
  public readonly usersFn: NodejsFunction;
  public readonly recordingsFn: NodejsFunction;
  public readonly tagsFn: NodejsFunction;
  public readonly adminFn: NodejsFunction;
  public readonly metricsFn: NodejsFunction;
  public readonly api: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const isProd = props.appEnv === 'prod';

    // Base CORS origins for each environment
    const baseCorsOrigins = isProd
      ? ['https://vocesdelaextincion.com', 'https://www.vocesdelaextincion.com']
      : ['http://localhost:3000', 'http://localhost:5173'];

    // Allow additional origins via environment variable (useful for Vercel previews, staging, etc.)
    const additionalOrigins = process.env.DEV_CORS_ORIGINS
      ? process.env.DEV_CORS_ORIGINS.split(',').map(url => url.trim())
      : [];

    const corsOrigins = isProd ? baseCorsOrigins : [...baseCorsOrigins, ...additionalOrigins];

    // -------------------------------------------------------------------------
    // Lambda Functions (one per route group)
    // -------------------------------------------------------------------------

    // Resolved at synth time; safe because infra and lambdas live in the same repo.
    const lambdaEntry = (group: string) =>
      path.join(__dirname, `../../../lambdas/${group}/handler.ts`);

    const lambdaDepsLockFile = path.join(__dirname, '../../../lambdas/package-lock.json');

    const commonFnProps = {
      runtime: lambda.Runtime.NODEJS_22_X,
      // Graviton2 — ~20% faster cold starts and ~20% cheaper than x86.
      architecture: lambda.Architecture.ARM_64,
      memorySize: isProd ? 512 : 256,
      timeout: cdk.Duration.seconds(30),
      depsLockFilePath: lambdaDepsLockFile,
      bundling: {
        minify: true,
        sourceMap: false,
        // Target must match the Lambda runtime. Avoids polyfilling modern JS features.
        target: 'node22',
      },
      // Explicitly set retention so CloudWatch log groups don't grow indefinitely.
      logRetention: isProd ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.TWO_WEEKS,
      environment: {
        TABLE_NAME: props.databaseStack.table.tableName,
        ENV: props.appEnv,
      },
    } as const;

    // --- auth ---
    // Cognito SDK calls: SignUp, InitiateAuth, ConfirmSignUp, ForgotPassword, ConfirmForgotPassword.
    this.authFn = new NodejsFunction(this, 'AuthFn', {
      functionName: `voces-${props.appEnv}-auth`,
      entry: lambdaEntry('auth'),
      handler: 'handler',
      ...commonFnProps,
      environment: {
        ...commonFnProps.environment,
        COGNITO_USER_POOL_ID: props.authStack.userPool.userPoolId,
        COGNITO_CLIENT_ID: props.authStack.userPoolClient.userPoolClientId,
      },
    });
    props.databaseStack.table.grantReadWriteData(this.authFn);
    this.authFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:SignUp',
        'cognito-idp:InitiateAuth',
        'cognito-idp:ConfirmSignUp',
        'cognito-idp:ForgotPassword',
        'cognito-idp:ConfirmForgotPassword',
        // GetUser is called after login to return profile data.
        'cognito-idp:GetUser',
      ],
      resources: [props.authStack.userPool.userPoolArn],
    }));

    // --- users ---
    // Alias for /auth/me — read-only profile data from DynamoDB.
    this.usersFn = new NodejsFunction(this, 'UsersFn', {
      functionName: `voces-${props.appEnv}-users`,
      entry: lambdaEntry('users'),
      handler: 'handler',
      ...commonFnProps,
    });
    props.databaseStack.table.grantReadData(this.usersFn);

    // --- recordings ---
    // Needs S3 for upload/delete and GetObject permission to sign presigned URLs.
    this.recordingsFn = new NodejsFunction(this, 'RecordingsFn', {
      functionName: `voces-${props.appEnv}-recordings`,
      entry: lambdaEntry('recordings'),
      handler: 'handler',
      ...commonFnProps,
      environment: {
        ...commonFnProps.environment,
        S3_BUCKET_NAME: props.storageStack.bucket.bucketName,
        // TTL values are in seconds.
        PRESIGNED_URL_TTL_FREE: '900',      // 15 minutes
        PRESIGNED_URL_TTL_PREMIUM: '3600',  // 1 hour
      },
    });
    props.databaseStack.table.grantReadWriteData(this.recordingsFn);
    // PutObject (upload), DeleteObject (delete), GetObject (generate presigned URLs).
    props.storageStack.bucket.grantReadWrite(this.recordingsFn);

    // --- tags ---
    this.tagsFn = new NodejsFunction(this, 'TagsFn', {
      functionName: `voces-${props.appEnv}-tags`,
      entry: lambdaEntry('tags'),
      handler: 'handler',
      ...commonFnProps,
    });
    props.databaseStack.table.grantReadWriteData(this.tagsFn);

    // --- admin ---
    // Manages users: needs AdminUpdateUserAttributes and AdminDeleteUser on the pool.
    this.adminFn = new NodejsFunction(this, 'AdminFn', {
      functionName: `voces-${props.appEnv}-admin`,
      entry: lambdaEntry('admin'),
      handler: 'handler',
      ...commonFnProps,
      environment: {
        ...commonFnProps.environment,
        COGNITO_USER_POOL_ID: props.authStack.userPool.userPoolId,
      },
    });
    props.databaseStack.table.grantReadWriteData(this.adminFn);
    this.adminFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:AdminDeleteUser',
        'cognito-idp:ListUsers',
        'cognito-idp:AdminGetUser',
      ],
      resources: [props.authStack.userPool.userPoolArn],
    }));

    // --- metrics ---
    // Public endpoint — aggregated counts only, no auth required.
    this.metricsFn = new NodejsFunction(this, 'MetricsFn', {
      functionName: `voces-${props.appEnv}-metrics`,
      entry: lambdaEntry('metrics'),
      handler: 'handler',
      ...commonFnProps,
    });
    // Scan-with-count only; no writes.
    props.databaseStack.table.grantReadData(this.metricsFn);

    // -------------------------------------------------------------------------
    // HTTP API
    // -------------------------------------------------------------------------

    this.api = new apigwv2.HttpApi(this, 'Api', {
      apiName: `voces-${props.appEnv}-api`,
      corsPreflight: {
        allowOrigins: corsOrigins,
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
        ],
        allowHeaders: ['Content-Type', 'Authorization'],
        // Long max-age reduces OPTIONS preflight round-trips in the browser.
        maxAge: cdk.Duration.hours(24),
      },
      // Defer stage creation so we can configure throttling and access logging.
      createDefaultStage: false,
    });

    // -------------------------------------------------------------------------
    // Cognito JWT Authorizer
    // -------------------------------------------------------------------------

    // API Gateway validates the token signature, expiry, and audience against
    // Cognito's JWKS endpoint before invoking any Lambda. No Lambda code needed
    // for authentication — only role-based authorization stays in Lambda.
    const issuerUrl = `https://cognito-idp.${this.region}.amazonaws.com/${props.authStack.userPool.userPoolId}`;

    const cognitoAuthorizer = new authorizers.HttpJwtAuthorizer(
      'CognitoAuthorizer',
      issuerUrl,
      {
        jwtAudience: [props.authStack.userPoolClient.userPoolClientId],
        // Strip "Bearer " prefix — API Gateway forwards the raw token to Cognito.
        identitySource: ['$request.header.Authorization'],
      },
    );

    // -------------------------------------------------------------------------
    // Lambda Integrations
    // -------------------------------------------------------------------------

    const authInt       = new integrations.HttpLambdaIntegration('AuthInt',       this.authFn);
    const usersInt      = new integrations.HttpLambdaIntegration('UsersInt',      this.usersFn);
    const recordingsInt = new integrations.HttpLambdaIntegration('RecordingsInt', this.recordingsFn);
    const tagsInt       = new integrations.HttpLambdaIntegration('TagsInt',       this.tagsFn);
    const adminInt      = new integrations.HttpLambdaIntegration('AdminInt',      this.adminFn);
    const metricsInt    = new integrations.HttpLambdaIntegration('MetricsInt',    this.metricsFn);

    // -------------------------------------------------------------------------
    // Routes — 22 total
    // -------------------------------------------------------------------------

    // Auth — public routes (no authorizer)
    this.api.addRoutes({ path: '/auth/register',         methods: [apigwv2.HttpMethod.POST], integration: authInt });
    this.api.addRoutes({ path: '/auth/login',             methods: [apigwv2.HttpMethod.POST], integration: authInt });
    this.api.addRoutes({ path: '/auth/verify-email',      methods: [apigwv2.HttpMethod.POST], integration: authInt });
    this.api.addRoutes({ path: '/auth/forgot-password',   methods: [apigwv2.HttpMethod.POST], integration: authInt });
    this.api.addRoutes({ path: '/auth/reset-password',    methods: [apigwv2.HttpMethod.POST], integration: authInt });
    // Auth — protected
    this.api.addRoutes({ path: '/auth/me', methods: [apigwv2.HttpMethod.GET], integration: authInt, authorizer: cognitoAuthorizer });

    // Users (deprecated alias for /auth/me — kept for backward compatibility)
    this.api.addRoutes({ path: '/users/me', methods: [apigwv2.HttpMethod.GET], integration: usersInt, authorizer: cognitoAuthorizer });

    // Recordings — all protected; admin enforcement happens inside the Lambda
    this.api.addRoutes({ path: '/recordings',              methods: [apigwv2.HttpMethod.GET],    integration: recordingsInt, authorizer: cognitoAuthorizer });
    this.api.addRoutes({ path: '/recordings',              methods: [apigwv2.HttpMethod.POST],   integration: recordingsInt, authorizer: cognitoAuthorizer });
    this.api.addRoutes({ path: '/recordings/download',     methods: [apigwv2.HttpMethod.POST],   integration: recordingsInt, authorizer: cognitoAuthorizer });
    this.api.addRoutes({ path: '/recordings/download-all', methods: [apigwv2.HttpMethod.POST],   integration: recordingsInt, authorizer: cognitoAuthorizer });
    this.api.addRoutes({ path: '/recordings/{id}',         methods: [apigwv2.HttpMethod.GET],    integration: recordingsInt, authorizer: cognitoAuthorizer });
    this.api.addRoutes({ path: '/recordings/{id}',         methods: [apigwv2.HttpMethod.PUT],    integration: recordingsInt, authorizer: cognitoAuthorizer });
    this.api.addRoutes({ path: '/recordings/{id}',         methods: [apigwv2.HttpMethod.DELETE], integration: recordingsInt, authorizer: cognitoAuthorizer });

    // Tags — all protected; admin enforcement inside Lambda for write operations
    this.api.addRoutes({ path: '/tags',      methods: [apigwv2.HttpMethod.GET],    integration: tagsInt, authorizer: cognitoAuthorizer });
    this.api.addRoutes({ path: '/tags',      methods: [apigwv2.HttpMethod.POST],   integration: tagsInt, authorizer: cognitoAuthorizer });
    this.api.addRoutes({ path: '/tags/{id}', methods: [apigwv2.HttpMethod.GET],    integration: tagsInt, authorizer: cognitoAuthorizer });
    this.api.addRoutes({ path: '/tags/{id}', methods: [apigwv2.HttpMethod.PUT],    integration: tagsInt, authorizer: cognitoAuthorizer });
    this.api.addRoutes({ path: '/tags/{id}', methods: [apigwv2.HttpMethod.DELETE], integration: tagsInt, authorizer: cognitoAuthorizer });

    // Admin — all protected; role check (ADMIN-only) enforced inside Lambda
    this.api.addRoutes({ path: '/admin/users',      methods: [apigwv2.HttpMethod.GET],    integration: adminInt, authorizer: cognitoAuthorizer });
    this.api.addRoutes({ path: '/admin/users/{id}', methods: [apigwv2.HttpMethod.GET],    integration: adminInt, authorizer: cognitoAuthorizer });
    this.api.addRoutes({ path: '/admin/users/{id}', methods: [apigwv2.HttpMethod.PUT],    integration: adminInt, authorizer: cognitoAuthorizer });
    this.api.addRoutes({ path: '/admin/users/{id}', methods: [apigwv2.HttpMethod.DELETE], integration: adminInt, authorizer: cognitoAuthorizer });

    // Metrics — public (no authorizer)
    this.api.addRoutes({ path: '/metrics', methods: [apigwv2.HttpMethod.GET], integration: metricsInt });

    // -------------------------------------------------------------------------
    // Access Logging
    // -------------------------------------------------------------------------

    const accessLogGroup = new logs.LogGroup(this, 'AccessLogGroup', {
      logGroupName: `/aws/apigateway/voces-${props.appEnv}-api`,
      retention: isProd ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -------------------------------------------------------------------------
    // Stage (throttling + access logging)
    // -------------------------------------------------------------------------

    const stage = new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi: this.api,
      stageName: '$default',
      autoDeploy: true,
      throttle: {
        // Burst absorbs sudden spikes; rate is the sustained average.
        burstLimit: isProd ? 1000 : 100,
        rateLimit: isProd ? 500 : 50,
      },
    });

    // Access logging is not exposed on the CDK L2 HttpStage — use the L1 escape hatch.
    const cfnStage = stage.node.defaultChild as apigwv2.CfnStage;
    cfnStage.addPropertyOverride('AccessLogSettings', {
      DestinationArn: accessLogGroup.logGroupArn,
      Format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        requestTime: '$context.requestTime',
        httpMethod: '$context.httpMethod',
        routeKey: '$context.routeKey',
        status: '$context.status',
        protocol: '$context.protocol',
        responseLength: '$context.responseLength',
        integrationError: '$context.integrationErrorMessage',
      }),
    });

    // API Gateway needs permission to create and write to the log delivery stream.
    accessLogGroup.grantWrite(new iam.ServicePrincipal('apigateway.amazonaws.com'));

    // -------------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------------

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      // The $default stage URL is the same as the execute-api endpoint root.
      value: this.api.apiEndpoint,
      exportName: `voces-${props.appEnv}-api-endpoint`,
    });

    new cdk.CfnOutput(this, 'ApiId', {
      value: this.api.apiId,
      exportName: `voces-${props.appEnv}-api-id`,
    });
  }
}
