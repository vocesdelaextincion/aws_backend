# Migration

This document outlines the steps to migrate the Voces v2 backend to AWS.
I'll first define what we have so far and then outline the migration process.

## What we have

- A backend server written in Node.js and TypeScript
- A PostgreSQL database (legacy — will be replaced)
- An S3 bucket for storing audio files
- An AWS account with the necessary permissions
- A Gmail account for sending emails

## What we need to do

- We'll move all the backend in Node to AWS Lambdas
- We'll move the PostgreSQL database to AWS DynamoDB (NoSQL, serverless-native)
- We'll move the S3 bucket to AWS S3
- We'll move the Gmail account to AWS SES
- We'll move the Google Cloud account to AWS Cognito

## Extras

- We'll implement a fully featured IAC based on GH actions.
- None of the features will be created based on anything different than aws.

## Actions

- Go to /legacy folder, there you'll find the old backend server.
- Read as much as you can about the current implementation. Try to start always by the doc files.
- Based on what you read there, create files outlining your plan to migrate this.
- The first step will be always to define a consistent IAC based on GH actions. Then the rest.
- Split your plan in parts, outlining as thorough as possible each step. The plan will be executed in parts, so no rush.
- The location of the new project will be the /aws folder.
- Work just on the plan, I don't want to see any code yet. Just .md files
