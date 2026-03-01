import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface AuthStackProps extends cdk.StackProps {
  appEnv: string;
}

export class AuthStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    // Part 3: Cognito User Pool will be defined here
  }
}
