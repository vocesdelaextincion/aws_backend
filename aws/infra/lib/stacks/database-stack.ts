import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface DatabaseStackProps extends cdk.StackProps {
  appEnv: string;
}

export class DatabaseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    // Part 2: DynamoDB table will be defined here
  }
}
