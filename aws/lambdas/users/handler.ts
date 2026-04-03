import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  // Part 7: /users/me — deprecated alias for /auth/me, kept for backward compatibility.
  void event;
  return { statusCode: 501, body: JSON.stringify({ error: 'Not implemented' }) };
}
