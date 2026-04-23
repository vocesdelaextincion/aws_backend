import { APIGatewayProxyEventV2, APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { docClient, TABLE_NAME } from '../shared/db';
import { ok, created, noContent, badRequest, forbidden, notFound, internalError } from '../shared/response';
import { randomUUID, createHash } from 'crypto';
import { extname } from 'path';

const s3 = new S3Client({});
const BUCKET = process.env.S3_BUCKET_NAME!;
const TTL_FREE = parseInt(process.env.PRESIGNED_URL_TTL_FREE ?? '900');
const TTL_PREMIUM = parseInt(process.env.PRESIGNED_URL_TTL_PREMIUM ?? '3600');

interface UserClaims { sub: string; role: string; plan: string; }

function getClaims(event: APIGatewayProxyEventV2): UserClaims {
  const claims = (event as APIGatewayProxyEventV2WithJWTAuthorizer).requestContext.authorizer?.jwt?.claims ?? {};
  return {
    sub: (claims.sub as string) ?? '',
    role: (claims['custom:role'] as string) || 'USER',
    plan: (claims['custom:plan'] as string) || 'FREE',
  };
}

function ttl(plan: string) { return plan === 'PREMIUM' ? TTL_PREMIUM : TTL_FREE; }

async function presign(fileKey: string, expiresIn: number): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: fileKey }), { expiresIn });
}

function formatRecording(item: Record<string, unknown>, fileUrl: string) {
  const id = (item.PK as string).replace('REC#', '');
  return {
    id,
    title: item.title,
    description: item.description ?? null,
    fileUrl,
    fileKey: item.fileKey,
    metadata: item.metadata ?? null,
    isFree: item.isFree,
    tags: item.tags ?? [],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

// Minimal multipart/form-data parser (no external dependencies)
interface MultipartResult { fields: Record<string, string>; file?: { filename: string; contentType: string; data: Buffer }; }

function bufferIndexOf(haystack: Buffer, needle: Buffer, start = 0): number {
  outer: for (let i = start; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function parseMultipart(event: APIGatewayProxyEventV2): MultipartResult {
  const ct = event.headers['content-type'] ?? '';
  const boundaryMatch = ct.match(/boundary=([^;]+)/);
  if (!boundaryMatch) return { fields: {} };

  const boundary = boundaryMatch[1].trim();
  const raw = event.isBase64Encoded ? Buffer.from(event.body!, 'base64') : Buffer.from(event.body ?? '');
  const delim = Buffer.from(`\r\n--${boundary}`);
  const start = Buffer.from(`--${boundary}`);

  const fields: Record<string, string> = {};
  let file: MultipartResult['file'];
  let pos = bufferIndexOf(raw, start, 0);
  if (pos === -1) return { fields };
  pos += start.length;

  while (pos < raw.length) {
    if (raw[pos] === 45 && raw[pos + 1] === 45) break;
    if (raw[pos] === 13 && raw[pos + 1] === 10) pos += 2;

    const nextPos = bufferIndexOf(raw, delim, pos);
    if (nextPos === -1) break;

    const part = raw.slice(pos, nextPos);
    const hEnd = bufferIndexOf(part, Buffer.from('\r\n\r\n'), 0);
    if (hEnd === -1) { pos = nextPos + delim.length; continue; }

    const headers = part.slice(0, hEnd).toString('utf-8');
    const body = part.slice(hEnd + 4);
    const disp = headers.match(/Content-Disposition:[^\r\n]*name="([^"]+)"(?:[^\r\n]*filename="([^"]+)")?/i);

    if (!disp) { pos = nextPos + delim.length; continue; }
    const [, name, filename] = disp;

    if (filename) {
      const ctMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
      file = { filename, contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream', data: body };
    } else {
      fields[name] = body.toString('utf-8');
    }
    pos = nextPos + delim.length;
  }

  return { fields, file };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  try {
    if (method === 'GET' && path === '/recordings') return await listRecordings(event);
    if (method === 'POST' && path === '/recordings') return await createRecording(event);
    if (method === 'POST' && path === '/recordings/download') return await download(event);
    if (method === 'POST' && path === '/recordings/download-all') return await downloadAll(event);
    if (method === 'GET' && /^\/recordings\/[\w-]+$/.test(path)) return await getRecording(event, path);
    if (method === 'PUT' && /^\/recordings\/[\w-]+$/.test(path)) return await updateRecording(event, path);
    if (method === 'DELETE' && /^\/recordings\/[\w-]+$/.test(path)) return await deleteRecording(event, path);
    return notFound();
  } catch (err) {
    console.error('Unhandled error in recordings handler:', err);
    return internalError();
  }
}

async function listRecordings(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const user = getClaims(event);
  const qs = event.queryStringParameters ?? {};
  const page = Math.max(1, parseInt(qs.page ?? '1') || 1);
  const limit = Math.min(100, Math.max(1, parseInt(qs.limit ?? '10') || 10));
  const searchTerms = qs.search ? qs.search.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];

  // Fetch all recordings from GSI2, then filter + paginate in memory (small dataset)
  const allItems: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': 'RECORDINGS' },
      ScanIndexForward: false,
      ExclusiveStartKey: lastKey,
    }));
    allItems.push(...(result.Items ?? []) as Record<string, unknown>[]);
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  // Filter by access (FREE users only see free recordings)
  let filtered = allItems.filter(item =>
    user.plan === 'PREMIUM' || user.role === 'ADMIN' || item.isFree === true
  );

  // Filter by search terms (case-insensitive, OR across title/description/tags)
  if (searchTerms.length > 0) {
    filtered = filtered.filter(item => {
      const searchable = [
        (item.title as string)?.toLowerCase() ?? '',
        (item.description as string)?.toLowerCase() ?? '',
        ...((item.tags as { name: string }[]) ?? []).map(t => t.name.toLowerCase()),
      ].join(' ');
      return searchTerms.some(term => searchable.includes(term));
    });
  }

  const totalCount = filtered.length;
  const totalPages = Math.ceil(totalCount / limit);
  const sliced = filtered.slice((page - 1) * limit, page * limit);
  const urlTtl = ttl(user.plan);

  const data = await Promise.all(sliced.map(async item => {
    const fileUrl = await presign(item.fileKey as string, urlTtl);
    return formatRecording(item, fileUrl);
  }));

  return ok({
    data,
    pagination: {
      currentPage: page,
      totalPages,
      totalCount,
      limit,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    },
    search: qs.search ?? null,
  });
}

async function getRecording(event: APIGatewayProxyEventV2, path: string): Promise<APIGatewayProxyResultV2> {
  const user = getClaims(event);
  const id = path.split('/').pop()!;

  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `REC#${id}`, SK: `REC#${id}` },
  }));

  if (!result.Item) return notFound('Recording not found');

  const item = result.Item as Record<string, unknown>;
  if (user.plan === 'FREE' && user.role !== 'ADMIN' && item.isFree !== true) {
    return forbidden('This recording requires a PREMIUM plan');
  }

  const fileUrl = await presign(item.fileKey as string, ttl(user.plan));
  return ok(formatRecording(item, fileUrl));
}

async function createRecording(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const user = getClaims(event);
  if (user.role !== 'ADMIN') return forbidden('Admin access required');

  const ct = event.headers['content-type'] ?? '';

  let title: string, description: string | undefined, tagsRaw: string | undefined,
    metadataRaw: string | undefined, isFreeRaw: string | undefined, fileKey: string;

  if (ct.includes('multipart/form-data')) {
    const { fields, file } = parseMultipart(event);
    title = fields.title;
    description = fields.description;
    tagsRaw = fields.tags;
    metadataRaw = fields.metadata;
    isFreeRaw = fields.isFree;

    if (!file) return badRequest('Recording file is required');
    if (!title?.trim()) return badRequest('title is required');

    const ext = extname(file.filename) || '.mp3';
    fileKey = `${randomUUID()}${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: fileKey,
      Body: file.data,
      ContentType: file.contentType,
    }));
  } else {
    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body ?? '{}'); } catch { return badRequest('Invalid JSON'); }
    title = body.title as string;
    description = body.description as string | undefined;
    tagsRaw = typeof body.tags === 'string' ? body.tags : JSON.stringify(body.tags);
    metadataRaw = typeof body.metadata === 'string' ? body.metadata : JSON.stringify(body.metadata);
    isFreeRaw = String(body.isFree ?? 'false');
    fileKey = body.fileKey as string;
    if (!fileKey) return badRequest('fileKey is required');
    if (!title?.trim()) return badRequest('title is required');
  }

  const tags = parseTags(tagsRaw);
  const metadata = parseMetadata(metadataRaw);
  const isFree = isFreeRaw === 'true' || isFreeRaw === '1';

  const id = randomUUID();
  const now = new Date().toISOString();

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `REC#${id}`,
      SK: `REC#${id}`,
      GSI2PK: 'RECORDINGS',
      GSI2SK: `${now}#${id}`,
      title: title.trim(),
      description: description?.trim(),
      fileKey,
      metadata,
      isFree,
      tags,
      createdAt: now,
      updatedAt: now,
      entity: 'RECORDING',
    },
  }));

  const fileUrl = await presign(fileKey, TTL_PREMIUM);
  return created(formatRecording({
    PK: `REC#${id}`, title: title.trim(), description, fileKey, metadata, isFree, tags, createdAt: now, updatedAt: now,
  }, fileUrl));
}

async function updateRecording(event: APIGatewayProxyEventV2, path: string): Promise<APIGatewayProxyResultV2> {
  const user = getClaims(event);
  if (user.role !== 'ADMIN') return forbidden('Admin access required');

  const id = path.split('/').pop()!;
  const existing = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `REC#${id}`, SK: `REC#${id}` },
  }));
  if (!existing.Item) return notFound('Recording not found');

  const ct = event.headers['content-type'] ?? '';
  let title: string | undefined, description: string | undefined, tagsRaw: string | undefined,
    metadataRaw: string | undefined, isFreeRaw: string | undefined, newFileKey: string | undefined;

  if (ct.includes('multipart/form-data')) {
    const { fields, file } = parseMultipart(event);
    title = fields.title;
    description = fields.description;
    tagsRaw = fields.tags;
    metadataRaw = fields.metadata;
    isFreeRaw = fields.isFree;

    if (file) {
      const ext = extname(file.filename) || '.mp3';
      newFileKey = `${randomUUID()}${ext}`;
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: newFileKey, Body: file.data, ContentType: file.contentType,
      }));
      // Delete old file
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: existing.Item.fileKey as string })).catch(() => {});
    }
  } else {
    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body ?? '{}'); } catch { return badRequest('Invalid JSON'); }
    title = body.title as string | undefined;
    description = body.description as string | undefined;
    tagsRaw = typeof body.tags !== 'undefined' ? (typeof body.tags === 'string' ? body.tags : JSON.stringify(body.tags)) : undefined;
    metadataRaw = typeof body.metadata !== 'undefined' ? (typeof body.metadata === 'string' ? body.metadata : JSON.stringify(body.metadata)) : undefined;
    isFreeRaw = typeof body.isFree !== 'undefined' ? String(body.isFree) : undefined;
  }

  const now = new Date().toISOString();
  const updates: string[] = ['updatedAt = :now'];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ':now': now };

  if (title?.trim()) { updates.push('title = :title'); values[':title'] = title.trim(); }
  if (typeof description !== 'undefined') { updates.push('description = :desc'); values[':desc'] = description?.trim(); }
  if (typeof tagsRaw !== 'undefined') { updates.push('tags = :tags'); values[':tags'] = parseTags(tagsRaw); }
  if (typeof metadataRaw !== 'undefined') { updates.push('metadata = :meta'); values[':meta'] = parseMetadata(metadataRaw); }
  if (typeof isFreeRaw !== 'undefined') { updates.push('isFree = :free'); values[':free'] = isFreeRaw === 'true' || isFreeRaw === '1'; }
  if (newFileKey) { updates.push('fileKey = :fk'); values[':fk'] = newFileKey; }

  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `REC#${id}`, SK: `REC#${id}` },
    UpdateExpression: `SET ${updates.join(', ')}`,
    ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
    ExpressionAttributeValues: values,
  }));

  const updated = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `REC#${id}`, SK: `REC#${id}` } }));
  const item = updated.Item as Record<string, unknown>;
  const fileUrl = await presign(item.fileKey as string, TTL_PREMIUM);
  return ok(formatRecording(item, fileUrl));
}

async function deleteRecording(event: APIGatewayProxyEventV2, path: string): Promise<APIGatewayProxyResultV2> {
  const user = getClaims(event);
  if (user.role !== 'ADMIN') return forbidden('Admin access required');

  const id = path.split('/').pop()!;
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `REC#${id}`, SK: `REC#${id}` },
  }));
  if (!result.Item) return notFound('Recording not found');

  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: result.Item.fileKey as string })).catch(() => {});
  await docClient.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: `REC#${id}`, SK: `REC#${id}` } }));

  return noContent();
}

async function download(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const user = getClaims(event);
  let body: { ids?: string[] };
  try { body = JSON.parse(event.body ?? '{}'); } catch { return badRequest('Invalid JSON'); }

  if (!Array.isArray(body.ids) || body.ids.length === 0) return badRequest('ids array is required');

  const urlTtl = ttl(user.plan);
  const results = await Promise.all(body.ids.map(async id => {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `REC#${id}`, SK: `REC#${id}` },
    }));
    if (!result.Item) return { id, error: 'Not found' };
    if (user.plan === 'FREE' && user.role !== 'ADMIN' && !result.Item.isFree) return { id, error: 'Requires PREMIUM plan' };
    const url = await presign(result.Item.fileKey as string, urlTtl);
    return { id, url };
  }));

  return ok({ downloads: results });
}

async function downloadAll(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const user = getClaims(event);
  if (user.plan === 'FREE' && user.role !== 'ADMIN') return forbidden('Download all requires a PREMIUM plan');

  const allItems: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': 'RECORDINGS' },
      ScanIndexForward: false,
      ExclusiveStartKey: lastKey,
    }));
    allItems.push(...(result.Items ?? []) as Record<string, unknown>[]);
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  const urlTtl = ttl(user.plan);
  const downloads = await Promise.all(allItems.map(async item => {
    const id = (item.PK as string).replace('REC#', '');
    const url = await presign(item.fileKey as string, urlTtl);
    return { id, title: item.title, url };
  }));

  return ok({ downloads });
}

function parseTags(raw: string | undefined): { id: string; name: string }[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map(t => typeof t === 'string' ? { id: createHash('md5').update(t).digest('hex').slice(0, 8), name: t } : t);
    }
  } catch { /* ignore */ }
  return [];
}

function parseMetadata(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}
