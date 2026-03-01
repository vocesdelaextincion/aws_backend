import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  // Part 7: Recordings routes will be implemented here
  // Covers: CRUD, bulk download, download-all, presigned URLs
  void event;
  return { statusCode: 501, body: JSON.stringify({ error: 'Not implemented' }) };
}
