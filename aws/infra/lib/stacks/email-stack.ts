import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface EmailStackProps extends cdk.StackProps {
  appEnv: string;
}

export class EmailStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EmailStackProps) {
    super(scope, id, props);

    // Part 5: SES configuration will be defined here
  }
}
