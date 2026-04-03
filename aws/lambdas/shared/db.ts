import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Instantiated outside the handler so the client is reused across warm invocations.
// No credentials needed — the Lambda execution role is used automatically.
const client = new DynamoDBClient({});

export const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    // Omit undefined attributes rather than serialising them as DynamoDB NULL.
    removeUndefinedValues: true,
  },
});

export const TABLE_NAME = process.env.TABLE_NAME!;
