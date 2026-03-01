import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface StorageStackProps extends cdk.StackProps {
  appEnv: string;
}

export class StorageStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    // Part 4: S3 bucket will be defined here
  }
}
