#!/usr/bin/env node
import * as dotenv from "dotenv";
dotenv.config(); // loads src/infra/.env if present; no-op otherwise

import * as cdk from "aws-cdk-lib";
import { DatabaseStack } from "../lib/stacks/database-stack";
import { AuthStack } from "../lib/stacks/auth-stack";
import { StorageStack } from "../lib/stacks/storage-stack";
import { EmailStack } from "../lib/stacks/email-stack";
import { ApiStack } from "../lib/stacks/api-stack";
import { MonitoringStack } from "../lib/stacks/monitoring-stack";

// Sensitive values come from environment variables, never from cdk.json.
// Locally: set these in src/infra/.env (gitignored).
// CI: AWS_ACCOUNT_ID is a GitHub Actions variable; ALERT_EMAIL is a secret.
const awsAccountId = process.env.AWS_ACCOUNT_ID;
if (!awsAccountId) {
  throw new Error("AWS_ACCOUNT_ID environment variable is required");
}

const app = new cdk.App();

const env = app.node.tryGetContext("env") as string;
if (!env || !["dev", "prod"].includes(env)) {
  throw new Error("Missing or invalid context: -c env=dev|prod");
}

const envConfig = app.node.tryGetContext("environments")[env] as {
  region: string;
  sesIdentity?: string;
  sesFromEmail?: string;
  sesVerifiedDomain?: string;
};

const awsEnv: cdk.Environment = {
  account: awsAccountId,
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

const storageStack = new StorageStack(app, `${stackPrefix}-storage`, {
  env: awsEnv,
  stackName: `${stackPrefix}-storage`,
  tags,
  appEnv: env,
});

// EmailStack must come before AuthStack — AuthStack needs SES configured
// before Cognito can be told to route emails through it.
const emailStack = new EmailStack(app, `${stackPrefix}-email`, {
  env: awsEnv,
  stackName: `${stackPrefix}-email`,
  tags,
  appEnv: env,
  sesIdentity: envConfig.sesIdentity,
});

const authStack = new AuthStack(app, `${stackPrefix}-auth`, {
  env: awsEnv,
  stackName: `${stackPrefix}-auth`,
  tags,
  appEnv: env,
  sesFromEmail: envConfig.sesFromEmail,
  sesVerifiedDomain: envConfig.sesVerifiedDomain,
});
// Only enforce deploy order when SES is actually in use.
if (envConfig.sesFromEmail) {
  authStack.addDependency(emailStack);
}

const apiStack = new ApiStack(app, `${stackPrefix}-api`, {
  env: awsEnv,
  stackName: `${stackPrefix}-api`,
  tags,
  appEnv: env,
  databaseStack,
  authStack,
  storageStack,
  emailStack,
});

new MonitoringStack(app, `${stackPrefix}-monitoring`, {
  env: awsEnv,
  stackName: `${stackPrefix}-monitoring`,
  tags,
  appEnv: env,
  databaseStack,
  authStack,
  storageStack,
  apiStack,
  // Prod only. Loaded from ALERT_EMAIL env var — set as a GitHub secret for
  // the production environment, or in src/infra/.env locally.
  alertEmail: process.env.ALERT_EMAIL,
});

app.synth();
