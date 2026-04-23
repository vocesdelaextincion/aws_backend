import { APIGatewayProxyEventV2, APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from '../shared/db';
import { ok, unauthorized, notFound, internalError } from '../shared/response';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const sub = (event as APIGatewayProxyEventV2WithJWTAuthorizer).requestContext.authorizer.jwt.claims.sub as string | undefined;
    if (!sub) return unauthorized();

    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USER#${sub}`, SK: `USER#${sub}` },
    }));

    if (!result.Item) return notFound('User not found');

    return ok({
      id: sub,
      email: result.Item.email,
      role: result.Item.role,
      plan: result.Item.plan,
      createdAt: result.Item.createdAt,
    });
  } catch (err) {
    console.error('Error in users handler:', err);
    return internalError();
  }
}
