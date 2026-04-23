import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from '../shared/db';
import { ok, internalError } from '../shared/response';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  void event;
  try {
    const [users, admins, recordings, tags] = await Promise.all([
      countByEntity('USER'),
      countByEntityAndRole('USER', 'ADMIN'),
      countByEntity('RECORDING'),
      countByEntity('TAG'),
    ]);

    return ok({ totalUsers: users, totalAdmins: admins, totalRecordings: recordings, totalTags: tags });
  } catch (err) {
    console.error('Error in metrics handler:', err);
    return internalError();
  }
}

async function countByEntity(entity: string): Promise<number> {
  let total = 0;
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'entity = :e',
      ExpressionAttributeValues: { ':e': entity },
      Select: 'COUNT',
      ExclusiveStartKey: lastKey,
    }));
    total += result.Count ?? 0;
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return total;
}

async function countByEntityAndRole(entity: string, role: string): Promise<number> {
  let total = 0;
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'entity = :e AND #r = :role',
      ExpressionAttributeNames: { '#r': 'role' },
      ExpressionAttributeValues: { ':e': entity, ':role': role },
      Select: 'COUNT',
      ExclusiveStartKey: lastKey,
    }));
    total += result.Count ?? 0;
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return total;
}
