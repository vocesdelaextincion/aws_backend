import * as cdk from 'aws-cdk-lib';
import * as ses from 'aws-cdk-lib/aws-ses';
import { Construct } from 'constructs';

export interface EmailStackProps extends cdk.StackProps {
  appEnv: string;
  // The email address (dev) or domain (prod) to register as an SES identity.
  // Must be manually verified after first deploy — see plan/09-MANUAL-AWS-SETUP.md.
  sesIdentity: string;
}

export class EmailStack extends cdk.Stack {
  // The ARN is used by AuthStack to wire Cognito → SES.
  public readonly sesIdentityArn: string;

  constructor(scope: Construct, id: string, props: EmailStackProps) {
    super(scope, id, props);

    const isProd = props.appEnv === 'prod';

    // Dev: email address identity (sandbox, good for verifying individual addresses).
    // Prod: domain identity (requires DNS records — DKIM, SPF, DMARC).
    // CDK creates the identity resource; actual verification is a manual post-deploy step.
    new ses.CfnEmailIdentity(this, 'SesIdentity', {
      emailIdentity: props.sesIdentity,
    });

    // CfnEmailIdentity doesn't expose the ARN as an attribute — construct it from parts.
    this.sesIdentityArn = cdk.Stack.of(this).formatArn({
      service: 'ses',
      resource: 'identity',
      resourceName: props.sesIdentity,
    });

    // Production only: configuration set for delivery tracking and suppression list.
    // Bounce/complaint events flow to CloudWatch so we can monitor sender reputation.
    if (isProd) {
      new ses.CfnConfigurationSet(this, 'ConfigurationSet', {
        name: `voces-${props.appEnv}-email`,
        reputationOptions: { reputationMetricsEnabled: true },
        // Automatically suppress addresses that bounce or mark us as spam.
        suppressionOptions: { suppressedReasons: ['BOUNCE', 'COMPLAINT'] },
      });
    }

    new cdk.CfnOutput(this, 'SesIdentityArn', {
      value: this.sesIdentityArn,
      exportName: `voces-${props.appEnv}-ses-identity-arn`,
    });
  }
}
