import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface AuthStackProps extends cdk.StackProps {
  appEnv: string;
  // The FROM address Cognito uses when sending via SES.
  // Must match (or belong to) the verified SES identity.
  sesFromEmail: string;
  // Set only for domain identities (prod). Tells Cognito the domain was verified
  // at the domain level rather than as a single address.
  sesVerifiedDomain?: string;
}

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const isProd = props.appEnv === 'prod';

    // Cognito invokes this Lambda before sending a verification or reset email,
    // letting us replace the default plain-text body with branded HTML.
    // Written as inline JavaScript so it deploys with the infra stack — no separate
    // Lambda build pipeline needed for what is just a string-templating function.
    const customMessageFn = new lambda.Function(this, 'CustomMessageFn', {
      functionName: `voces-${props.appEnv}-cognito-custom-message`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
exports.handler = async function(event) {
  var code = event.request.codeParameter || event.request.temporaryPassword || '';

  if (
    event.triggerSource === 'CustomMessage_SignUp' ||
    event.triggerSource === 'CustomMessage_ResendCode'
  ) {
    event.response.emailSubject = 'Voces de la Extincion - Verify your email';
    event.response.emailMessage =
      '<h2>Welcome to Voces de la Extincion!</h2>' +
      '<p>Your verification code is:</p>' +
      '<h1 style="letter-spacing:4px;font-family:monospace;">' + code + '</h1>' +
      '<p>This code expires in 24 hours.</p>';
  } else if (event.triggerSource === 'CustomMessage_ForgotPassword') {
    event.response.emailSubject = 'Voces de la Extincion - Reset your password';
    event.response.emailMessage =
      '<h2>Password Reset</h2>' +
      '<p>Your password reset code is:</p>' +
      '<h1 style="letter-spacing:4px;font-family:monospace;">' + code + '</h1>' +
      '<p>This code expires in 1 hour. If you did not request this, you can ignore this email.</p>';
  } else if (event.triggerSource === 'CustomMessage_AdminCreateUser') {
    event.response.emailSubject = 'Voces de la Extincion - Your account';
    event.response.emailMessage =
      '<h2>Your account has been created</h2>' +
      '<p>Your temporary password is:</p>' +
      '<h1 style="letter-spacing:4px;font-family:monospace;">' + code + '</h1>' +
      '<p>Please log in and change your password immediately.</p>';
  }

  return event;
};
      `),
      // Cold starts on this function directly delay the auth flow, so keep it warm.
      // 128 MB is the minimum and more than enough for pure string operations.
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
    });

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

      // Route Cognito emails through SES. This removes the default 50 emails/day limit
      // and lets us send from our own domain. The identity must be verified in SES
      // before Cognito can use it (manual step — see plan/09-MANUAL-AWS-SETUP.md).
      email: cognito.UserPoolEmail.withSES({
        fromEmail: props.sesFromEmail,
        fromName: 'Voces de la Extinción',
        replyTo: props.sesFromEmail,
        // Required for domain identities (prod). Omit for email address identities (dev).
        sesVerifiedDomain: props.sesVerifiedDomain,
        // SES must be in the same region as the User Pool.
        sesRegion: cdk.Stack.of(this).region,
      }),

      // Branded HTML emails via the Custom Message Lambda trigger.
      lambdaTriggers: {
        customMessage: customMessageFn,
      },

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
