import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface AuthStackProps extends cdk.StackProps {
  appEnv: string;
}

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const isProd = props.appEnv === 'prod';

    // Replaces legacy custom JWT + bcrypt. Cognito handles password hashing,
    // email verification codes, password reset codes, and token issuance.
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `voces-${props.appEnv}-users`,
      selfSignUpEnabled: true,

      // Email is the only sign-in identifier — no usernames.
      signInAliases: { email: true },
      autoVerify: { email: true },

      standardAttributes: {
        email: { required: true, mutable: true },
      },

      // custom:role and custom:plan are ADMIN-writable only (via AdminUpdateUserAttributes).
      // The app client's writeAttributes intentionally excludes these to prevent privilege escalation.
      customAttributes: {
        role: new cognito.StringAttribute({ mutable: true }),
        plan: new cognito.StringAttribute({ mutable: true }),
      },

      // Matches legacy minimum (8 chars). Kept permissive — no uppercase/symbol requirements
      // to avoid frustrating users of a non-commercial project.
      passwordPolicy: {
        minLength: 8,
        requireDigits: true,
        requireLowercase: false,
        requireUppercase: false,
        requireSymbols: false,
      },

      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,

      // Verification flow uses 6-digit codes (not magic links).
      // Frontend must present a code input form on the verify-email screen.
      userVerification: {
        emailStyle: cognito.VerificationEmailStyle.CODE,
        emailSubject: 'Voces de la Extinción — Verify your email',
        emailBody: 'Your verification code is {####}. It expires in 24 hours.',
      },

      // TODO (Part 5): Switch to SES for prod to raise sending limits and use a custom domain.
      // email: cognito.UserPoolEmail.withSES({ ... })

      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      deletionProtection: isProd,
    });

    // App client — public client (no secret) for SPA/mobile compatibility.
    // USER_PASSWORD_AUTH matches the legacy plain-password login flow.
    // REFRESH_TOKEN_AUTH is implicitly always enabled.
    this.userPoolClient = this.userPool.addClient('AppClient', {
      userPoolClientName: `voces-${props.appEnv}-app-client`,
      generateSecret: false,
      authFlows: {
        userPassword: true,
        userSrp: false,
        adminUserPassword: false,
        custom: false,
      },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      enableTokenRevocation: true,

      // Prevents attackers from discovering which emails are registered
      // (mirrors the legacy system's behaviour).
      preventUserExistenceErrors: true,

      readAttributes: new cognito.ClientAttributes()
        .withStandardAttributes({ email: true, emailVerified: true })
        .withCustomAttributes('role', 'plan'),

      // SECURITY: custom:role and custom:plan are deliberately excluded.
      // Users cannot self-escalate to ADMIN or PREMIUM.
      // Only AdminUpdateUserAttributes (admin Lambda) may write these.
      writeAttributes: new cognito.ClientAttributes()
        .withStandardAttributes({ email: true }),
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      exportName: `voces-${props.appEnv}-user-pool-id`,
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      exportName: `voces-${props.appEnv}-user-pool-client-id`,
    });

    new cdk.CfnOutput(this, 'UserPoolArn', {
      value: this.userPool.userPoolArn,
      exportName: `voces-${props.appEnv}-user-pool-arn`,
    });
  }
}
