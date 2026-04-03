import { z } from 'zod';

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------
// Stored at PK = USER#<cognitoSub>, SK = USER#<cognitoSub>.
// Auth fields (password, tokens, isVerified) are managed by Cognito — not here.
// ---------------------------------------------------------------------------

export const UserSchema = z.object({
  PK: z.string(),          // USER#<sub>
  SK: z.string(),          // USER#<sub>
  GSI1PK: z.string(),      // USEREMAIL#<email>  — enables email lookup via GSI1
  GSI1SK: z.string(),      // USER#<sub>
  email: z.string().email(),
  plan: z.enum(['FREE', 'PREMIUM']),
  role: z.enum(['USER', 'ADMIN']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  entity: z.literal('USER'),
});

export type User = z.infer<typeof UserSchema>;

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------
// Stored at PK = REC#<id>, SK = REC#<id>.
// GSI2 supports chronological listing: GSI2PK = "RECORDINGS", GSI2SK = "<createdAt>#<id>".
// Tag names are denormalised onto the recording item for efficient reads.
// ---------------------------------------------------------------------------

export const RecordingSchema = z.object({
  PK: z.string(),               // REC#<id>
  SK: z.string(),               // REC#<id>
  GSI2PK: z.literal('RECORDINGS'),
  GSI2SK: z.string(),           // <createdAt>#<id>  — ISO timestamp prefix keeps natural sort order
  title: z.string(),
  description: z.string().optional(),
  fileKey: z.string(),          // S3 object key — never a permanent public URL
  metadata: z.record(z.unknown()).optional(),
  isFree: z.boolean().default(false),
  tags: z.array(z.string()).default([]),  // denormalised tag names for display
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  entity: z.literal('RECORDING'),
});

export type Recording = z.infer<typeof RecordingSchema>;

// ---------------------------------------------------------------------------
// Tag
// ---------------------------------------------------------------------------
// Stored at PK = TAG#<id>, SK = TAG#<id>.
// GSI1 supports name lookup: GSI1PK = TAGNAME#<name>.
// ---------------------------------------------------------------------------

export const TagSchema = z.object({
  PK: z.string(),          // TAG#<id>
  SK: z.string(),          // TAG#<id>
  GSI1PK: z.string(),      // TAGNAME#<name>  — enables tag-by-name lookup via GSI1
  GSI1SK: z.string(),      // TAG#<id>
  name: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  entity: z.literal('TAG'),
});

export type Tag = z.infer<typeof TagSchema>;

// ---------------------------------------------------------------------------
// Tag-Recording relationship (adjacency list item)
// ---------------------------------------------------------------------------
// Stored at PK = TAG#<tagId>, SK = REC#<recId>.
// Enables "get all recordings for a tag" (query PK = TAG#<id>, SK begins_with REC#).
// GSI1 reverse: GSI1PK = REC#<recId>, GSI1SK = TAG#<tagName>
// Enables "get all tags for a recording" (query GSI1PK = REC#<id>).
// ---------------------------------------------------------------------------

export const TagRecordingSchema = z.object({
  PK: z.string(),       // TAG#<tagId>
  SK: z.string(),       // REC#<recId>
  GSI1PK: z.string(),   // REC#<recId>
  GSI1SK: z.string(),   // TAG#<tagName>
  entity: z.literal('TAG_RECORDING'),
});

export type TagRecording = z.infer<typeof TagRecordingSchema>;
