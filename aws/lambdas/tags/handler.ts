import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  // Part 7: Tags routes will be implemented here
  // Covers: list, get, create, update, delete
  void event;
  return { statusCode: 501, body: JSON.stringify({ error: 'Not implemented' }) };
}
