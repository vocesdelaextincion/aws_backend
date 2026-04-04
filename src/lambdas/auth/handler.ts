import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  // Part 7: Auth routes will be implemented here
  // Covers: register, login, verify-email, forgot-password, reset-password, me
  void event;
  return { statusCode: 501, body: JSON.stringify({ error: 'Not implemented' }) };
}
