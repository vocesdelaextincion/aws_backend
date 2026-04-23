import { APIGatewayProxyEventV2, APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand, UpdateCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from '../shared/db';
import { ok, created, noContent, badRequest, forbidden, notFound, internalError } from '../shared/response';
import { randomUUID } from 'crypto';

function getClaims(event: APIGatewayProxyEventV2) {
  const claims = (event as APIGatewayProxyEventV2WithJWTAuthorizer).requestContext.authorizer?.jwt?.claims ?? {};
  return {
    role: (claims['custom:role'] as string) || 'USER',
  };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  try {
    if (method === 'GET' && path === '/tags') return await listTags();
    if (method === 'POST' && path === '/tags') return await createTag(event);
    if (method === 'GET' && /^\/tags\/[\w-]+$/.test(path)) return await getTag(path);
    if (method === 'PUT' && /^\/tags\/[\w-]+$/.test(path)) return await updateTag(event, path);
    if (method === 'DELETE' && /^\/tags\/[\w-]+$/.test(path)) return await deleteTag(event, path);
    return notFound();
  } catch (err) {
    console.error('Unhandled error in tags handler:', err);
    return internalError();
  }
}

async function listTags(): Promise<APIGatewayProxyResultV2> {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'entity = :e',
      ExpressionAttributeValues: { ':e': 'TAG' },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(result.Items ?? []) as Record<string, unknown>[]);
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  const tags = items.map(formatTag);
  return ok(tags);
}

async function createTag(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const { role } = getClaims(event);
  if (role !== 'ADMIN') return forbidden('Admin access required');

  let body: { name?: string };
  try { body = JSON.parse(event.body ?? '{}'); } catch { return badRequest('Invalid JSON'); }

  const { name } = body;
  if (!name?.trim()) return badRequest('name is required');

  const id = randomUUID();
  const now = new Date().toISOString();

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `TAG#${id}`,
      SK: `TAG#${id}`,
      GSI1PK: `TAGNAME#${name.trim().toLowerCase()}`,
      GSI1SK: `TAG#${id}`,
      name: name.trim(),
      createdAt: now,
      updatedAt: now,
      entity: 'TAG',
    },
    ConditionExpression: 'attribute_not_exists(PK)',
  }));

  return created({ id, name: name.trim(), createdAt: now, updatedAt: now });
}

async function getTag(path: string): Promise<APIGatewayProxyResultV2> {
  const id = path.split('/').pop()!;
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TAG#${id}`, SK: `TAG#${id}` },
  }));

  if (!result.Item) return notFound('Tag not found');
  return ok(formatTag(result.Item));
}

async function updateTag(event: APIGatewayProxyEventV2, path: string): Promise<APIGatewayProxyResultV2> {
  const { role } = getClaims(event);
  if (role !== 'ADMIN') return forbidden('Admin access required');

  let body: { name?: string };
  try { body = JSON.parse(event.body ?? '{}'); } catch { return badRequest('Invalid JSON'); }

  const { name } = body;
  if (!name?.trim()) return badRequest('name is required');

  const id = path.split('/').pop()!;
  const now = new Date().toISOString();

  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TAG#${id}`, SK: `TAG#${id}` },
  }));
  if (!result.Item) return notFound('Tag not found');

  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TAG#${id}`, SK: `TAG#${id}` },
    UpdateExpression: 'SET #n = :name, GSI1PK = :gsi1pk, updatedAt = :now',
    ExpressionAttributeNames: { '#n': 'name' },
    ExpressionAttributeValues: {
      ':name': name.trim(),
      ':gsi1pk': `TAGNAME#${name.trim().toLowerCase()}`,
      ':now': now,
    },
  }));

  return ok({ id, name: name.trim(), createdAt: result.Item.createdAt, updatedAt: now });
}

async function deleteTag(event: APIGatewayProxyEventV2, path: string): Promise<APIGatewayProxyResultV2> {
  const { role } = getClaims(event);
  if (role !== 'ADMIN') return forbidden('Admin access required');

  const id = path.split('/').pop()!;

  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TAG#${id}`, SK: `TAG#${id}` },
  }));
  if (!result.Item) return notFound('Tag not found');

  await docClient.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TAG#${id}`, SK: `TAG#${id}` },
  }));

  return noContent();
}

function formatTag(item: Record<string, unknown>) {
  const id = (item.PK as string).replace('TAG#', '');
  return { id, name: item.name, createdAt: item.createdAt, updatedAt: item.updatedAt };
}
