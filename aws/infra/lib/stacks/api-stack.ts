import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
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
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // Parts 6 & 7: API Gateway + Lambda functions will be defined here
  }
}
