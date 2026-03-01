import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  // Part 7: Metrics route will be implemented here
  // Covers: GET /metrics (public, aggregate counts)
  void event;
  return { statusCode: 501, body: JSON.stringify({ error: 'Not implemented' }) };
}
