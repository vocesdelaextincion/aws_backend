#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { DatabaseStack } from "../lib/stacks/database-stack";
import { AuthStack } from "../lib/stacks/auth-stack";
import { StorageStack } from "../lib/stacks/storage-stack";
import { EmailStack } from "../lib/stacks/email-stack";
import { ApiStack } from "../lib/stacks/api-stack";

const app = new cdk.App();

const env = app.node.tryGetContext("env") as string;
if (!env || !["dev", "prod"].includes(env)) {
  throw new Error("Missing or invalid context: -c env=dev|prod");
}

const envConfig = app.node.tryGetContext("environments")[env] as {
  account: string;
  region: string;
};

const awsEnv: cdk.Environment = {
  account: envConfig.account,
  region: envConfig.region,
};

const stackPrefix = `voces-${env}`;
const tags = { Project: "voces-de-la-extincion", Environment: env };

const databaseStack = new DatabaseStack(app, `${stackPrefix}-database`, {
  env: awsEnv,
  stackName: `${stackPrefix}-database`,
  tags,
  appEnv: env,
});

const authStack = new AuthStack(app, `${stackPrefix}-auth`, {
  env: awsEnv,
  stackName: `${stackPrefix}-auth`,
  tags,
  appEnv: env,
});

const storageStack = new StorageStack(app, `${stackPrefix}-storage`, {
  env: awsEnv,
  stackName: `${stackPrefix}-storage`,
  tags,
  appEnv: env,
});

const emailStack = new EmailStack(app, `${stackPrefix}-email`, {
  env: awsEnv,
  stackName: `${stackPrefix}-email`,
  tags,
  appEnv: env,
});

new ApiStack(app, `${stackPrefix}-api`, {
  env: awsEnv,
  stackName: `${stackPrefix}-api`,
  tags,
  appEnv: env,
  databaseStack,
  authStack,
  storageStack,
  emailStack,
});

app.synth();
