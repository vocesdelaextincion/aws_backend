import { APIGatewayProxyEventV2, APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetCommand, UpdateCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from '../shared/db';
import { ok, noContent, badRequest, forbidden, notFound, internalError } from '../shared/response';

const cognito = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID!;

function getClaims(event: APIGatewayProxyEventV2) {
  const claims = (event as APIGatewayProxyEventV2WithJWTAuthorizer).requestContext.authorizer?.jwt?.claims ?? {};
  return { role: (claims['custom:role'] as string) || 'USER' };
}

function requireAdmin(event: APIGatewayProxyEventV2): APIGatewayProxyResultV2 | null {
  return getClaims(event).role === 'ADMIN' ? null : forbidden('Admin access required');
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  try {
    if (method === 'GET' && path === '/admin/users') return await listUsers(event);
    if (method === 'GET' && /^\/admin\/users\/[\w-]+$/.test(path)) return await getUser(event, path);
    if (method === 'PUT' && /^\/admin\/users\/[\w-]+$/.test(path)) return await updateUser(event, path);
    if (method === 'DELETE' && /^\/admin\/users\/[\w-]+$/.test(path)) return await deleteUser(event, path);
    return notFound();
  } catch (err) {
    console.error('Unhandled error in admin handler:', err);
    return internalError();
  }
}

async function listUsers(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const guard = requireAdmin(event);
  if (guard) return guard;

  const qs = event.queryStringParameters ?? {};
  const page = Math.max(1, parseInt(qs.page ?? '1') || 1);
  const limit = Math.min(100, Math.max(1, parseInt(qs.limit ?? '10') || 10));
  const searchTerms = qs.search ? qs.search.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];

  const allItems: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'entity = :e',
      ExpressionAttributeValues: { ':e': 'USER' },
      ExclusiveStartKey: lastKey,
    }));
    allItems.push(...(result.Items ?? []) as Record<string, unknown>[]);
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  // Sort by createdAt desc
  allItems.sort((a, b) => ((b.createdAt as string) ?? '').localeCompare((a.createdAt as string) ?? ''));

  let filtered = allItems;
  if (searchTerms.length > 0) {
    filtered = allItems.filter(item =>
      searchTerms.some(term => ((item.email as string) ?? '').toLowerCase().includes(term))
    );
  }

  const totalCount = filtered.length;
  const totalPages = Math.ceil(totalCount / limit);
  const sliced = filtered.slice((page - 1) * limit, page * limit);

  return ok({
    data: sliced.map(formatUser),
    pagination: { currentPage: page, totalPages, totalCount, limit, hasNextPage: page < totalPages, hasPreviousPage: page > 1 },
    search: qs.search ?? null,
  });
}

async function getUser(event: APIGatewayProxyEventV2, path: string): Promise<APIGatewayProxyResultV2> {
  const guard = requireAdmin(event);
  if (guard) return guard;

  const id = path.split('/').pop()!;
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${id}`, SK: `USER#${id}` },
  }));

  if (!result.Item) return notFound('User not found');
  return ok(formatUser(result.Item as Record<string, unknown>));
}

async function updateUser(event: APIGatewayProxyEventV2, path: string): Promise<APIGatewayProxyResultV2> {
  const guard = requireAdmin(event);
  if (guard) return guard;

  let body: { plan?: string; role?: string };
  try { body = JSON.parse(event.body ?? '{}'); } catch { return badRequest('Invalid JSON'); }

  const { plan, role } = body;

  if (plan && !['FREE', 'PREMIUM'].includes(plan)) return badRequest('plan must be FREE or PREMIUM');
  if (role && !['USER', 'ADMIN'].includes(role)) return badRequest('role must be USER or ADMIN');

  const id = path.split('/').pop()!;
  const existing = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${id}`, SK: `USER#${id}` },
  }));
  if (!existing.Item) return notFound('User not found');

  const now = new Date().toISOString();
  const updates: string[] = ['updatedAt = :now'];
  const values: Record<string, unknown> = { ':now': now };

  if (plan) { updates.push('#p = :plan'); values[':plan'] = plan; }
  if (role) { updates.push('#r = :role'); values[':role'] = role; }

  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${id}`, SK: `USER#${id}` },
    UpdateExpression: `SET ${updates.join(', ')}`,
    ExpressionAttributeNames: { '#p': 'plan', '#r': 'role' },
    ExpressionAttributeValues: values,
  }));

  // Keep Cognito custom attributes in sync
  const cognitoAttrs = [];
  if (plan) cognitoAttrs.push({ Name: 'custom:plan', Value: plan });
  if (role) cognitoAttrs.push({ Name: 'custom:role', Value: role });

  if (cognitoAttrs.length > 0) {
    await cognito.send(new AdminUpdateUserAttributesCommand({
      UserPoolId: USER_POOL_ID,
      Username: existing.Item.email as string,
      UserAttributes: cognitoAttrs,
    })).catch(err => console.warn('Cognito update failed (non-fatal):', err));
  }

  const updated = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `USER#${id}`, SK: `USER#${id}` } }));
  return ok(formatUser(updated.Item as Record<string, unknown>));
}

async function deleteUser(event: APIGatewayProxyEventV2, path: string): Promise<APIGatewayProxyResultV2> {
  const guard = requireAdmin(event);
  if (guard) return guard;

  const id = path.split('/').pop()!;
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${id}`, SK: `USER#${id}` },
  }));
  if (!result.Item) return notFound('User not found');

  await cognito.send(new AdminDeleteUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: result.Item.email as string,
  })).catch(err => console.warn('Cognito delete failed (non-fatal):', err));

  await docClient.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${id}`, SK: `USER#${id}` },
  }));

  return noContent();
}

function formatUser(item: Record<string, unknown>) {
  const id = (item.PK as string).replace('USER#', '');
  return { id, email: item.email, plan: item.plan, role: item.role, createdAt: item.createdAt, updatedAt: item.updatedAt };
}
