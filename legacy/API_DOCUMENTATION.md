# Voces de la Extinción API - Complete Documentation

## Overview

**Voces de la Extinción** is a RESTful API for managing audio recordings with tagging, search, and authentication capabilities. Built with Express.js, TypeScript, PostgreSQL, and AWS S3.

### Technology Stack

- **Runtime**: Node.js with TypeScript
- **Framework**: Express.js 5.x
- **Database**: PostgreSQL with Prisma ORM
- **Authentication**: JWT (7-day expiration)
- **File Storage**: AWS S3
- **Email**: Gmail OAuth 2.0 via Nodemailer
- **Security**: bcrypt password hashing

### Base URL

```
http://localhost:3001
```

---

## Data Models

### User

```typescript
{
  id: string; // CUID
  email: string; // unique
  password: string; // bcrypt hashed
  isVerified: boolean; // default: false
  plan: "FREE" | "PREMIUM"; // default: FREE
  role: "USER" | "ADMIN"; // default: USER
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

### Recording

```typescript
{
  id: string              // CUID
  title: string           // required
  description: string     // optional
  fileUrl: string         // S3 URL, unique
  fileKey: string         // S3 key, unique
  metadata: JSON          // optional, flexible schema
  tags: Tag[]            // many-to-many
  createdAt: DateTime
  updatedAt: DateTime
}
```

### Tag

```typescript
{
  id: string              // CUID
  name: string            // unique
  recordings: Recording[] // many-to-many
}
```

---

## API Endpoints - Public

### 1. Register

**POST** `/auth/register`

**Request**:

```json
{
  "email": "user@example.com",
  "password": "password123" // min 8 chars
}
```

**Response** (201):

```json
{
  "message": "User created successfully. Please verify your email.",
  "user": {
    "id": "clxxxxx",
    "email": "user@example.com",
    "plan": "FREE",
    "role": "USER"
  }
}
```

**Errors**:

- `409`: Email already exists
- `400`: Validation errors

**Notes**: Sends verification email with 1-hour token expiration

---

### 2. Verify Email

**POST** `/auth/verify-email/:token`

**Response** (200):

```json
{
  "message": "Email verified successfully. You can now log in."
}
```

**Errors**:

- `404`: Invalid token
- `410`: Token expired

---

### 3. Login

**POST** `/auth/login`

**Request**:

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response** (200):

```json
{
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "clxxxxx",
    "email": "user@example.com",
    "plan": "FREE",
    "role": "USER"
  }
}
```

**Errors**:

- `401`: Invalid credentials
- `403`: Email not verified

**Token**: Valid for 7 days, include in `Authorization: Bearer <token>` header

---

### 4. Forgot Password

**POST** `/auth/forgot-password`

**Request**:

```json
{
  "email": "user@example.com"
}
```

**Response** (200):

```json
{
  "message": "If a user with that email exists, a password reset link has been sent."
}
```

**Notes**:

- Always returns success (prevents email enumeration)
- Reset token expires in 1 hour

---

### 5. Reset Password

**POST** `/auth/reset-password/:token`

**Request**:

```json
{
  "password": "newPassword123" // min 8 chars
}
```

**Response** (200):

```json
{
  "message": "Password has been reset successfully."
}
```

**Errors**: `400`: Invalid or expired token

---

## API Endpoints - Protected

_All require `Authorization: Bearer <token>` header_

### 6. Get Current User

**GET** `/auth/me` or **GET** `/users/me`

**Response** (200):

```json
{
  "id": "clxxxxx",
  "email": "user@example.com",
  "plan": "FREE",
  "role": "USER",
  "isVerified": true
}
```

---

### 7. Get All Recordings

**GET** `/recordings`

**Query Parameters**:

- `page` (number): Page number (default: 1)
- `limit` (number): Items per page (default: 10, max: 100)
- `search` (string): Search term(s) - comma-separated

**Search Capabilities**:

- Searches: title, description, tag names
- Case-insensitive
- Multiple terms: `?search=nature,birds` (OR logic)
- Single term: `?search=bird sounds`

**Examples**:

```
GET /recordings
GET /recordings?page=2&limit=20
GET /recordings?search=bird sounds
GET /recordings?search=nature,birds&page=1&limit=5
```

**Response** (200):

```json
{
  "data": [
    {
      "id": "clxxxxx",
      "title": "Bird Song",
      "description": "Beautiful bird sounds",
      "fileUrl": "https://bucket.s3.amazonaws.com/uuid.mp3",
      "fileKey": "uuid.mp3",
      "metadata": {
        "duration": "120",
        "location": "Amazon Rainforest"
      },
      "tags": [
        { "id": "cltag1", "name": "birds" },
        { "id": "cltag2", "name": "nature" }
      ],
      "createdAt": "2025-01-15T10:30:00.000Z",
      "updatedAt": "2025-01-15T10:30:00.000Z"
    }
  ],
  "pagination": {
    "currentPage": 1,
    "totalPages": 5,
    "totalCount": 47,
    "limit": 10,
    "hasNextPage": true,
    "hasPreviousPage": false
  },
  "search": "bird sounds"
}
```

**Sorting**: By `createdAt` descending (newest first)

---

### 8. Get Recording by ID

**GET** `/recordings/:id`

**Response** (200):

```json
{
  "id": "clxxxxx",
  "title": "Bird Song",
  "description": "Beautiful bird sounds",
  "fileUrl": "https://bucket.s3.amazonaws.com/uuid.mp3",
  "fileKey": "uuid.mp3",
  "metadata": { "duration": "120" },
  "tags": [{ "id": "cltag1", "name": "birds" }],
  "createdAt": "2025-01-15T10:30:00.000Z",
  "updatedAt": "2025-01-15T10:30:00.000Z"
}
```

**Errors**: `404`: Recording not found

---

### 9. Get Metrics (Public)

**GET** `/metrics`

**Response** (200):

```json
{
  "totalUsers": 1523,
  "totalAdmins": 5,
  "totalRecordings": 3847,
  "totalTags": 234
}
```

**Notes**: Public endpoint, no authentication required

---

## Authentication Details

### JWT Token

- **Expiration**: 7 days
- **Payload**: `{ id: "user-id", role: "USER"|"ADMIN" }`
- **Header**: `Authorization: Bearer <token>`

### Token Flow

1. Extract token from Authorization header
2. Verify signature with JWT_SECRET
3. Decode user ID
4. Query database for user
5. Attach user to request
6. Proceed to controller

**User object on request**:

```typescript
{
  id: string,
  email: string,
  plan: "FREE" | "PREMIUM",
  role: "USER" | "ADMIN",
  isVerified: boolean
}
```

---

## File Storage (AWS S3)

### Upload Process

1. File received via multer (memory storage)
2. Generate UUID-based key: `{UUID}{extension}`
3. Upload buffer to S3
4. Store URL and key in database

### Delete Process

1. Delete from S3 first
2. Delete database record

### Environment Variables

```bash
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
AWS_S3_BUCKET_NAME=your-bucket
```

---

## Email Service (Gmail OAuth 2.0)

### Configuration

```bash
EMAIL_USER=your-email@gmail.com
GMAIL_CLIENT_ID=your-client-id
GMAIL_CLIENT_SECRET=your-client-secret
GMAIL_REFRESH_TOKEN=your-refresh-token
EMAIL_FROM="Voces de la Extinción <email@gmail.com>"
```

### Email Types

1. **Verification**: Sent on registration, 1-hour expiration
2. **Password Reset**: Sent on forgot password, 1-hour expiration

Both include plain text and HTML versions

---

## Validation Rules

### Registration & Password Reset

- Email: Valid format, normalized
- Password: Minimum 8 characters

### Recording Create/Update

- Title: Required, trimmed, HTML-escaped
- Description: Optional, trimmed, HTML-escaped
- Tags: Optional array of tag IDs (JSON string or array)
- Metadata: Optional, valid JSON string
- File: Required on create, optional on update

---

## Error Responses

### Standard Error

```json
{
  "message": "Error description"
}
```

### Validation Errors

```json
{
  "errors": [
    {
      "msg": "Please provide a valid email address.",
      "param": "email",
      "location": "body"
    }
  ]
}
```

### HTTP Status Codes

- `200`: Success (GET, PUT)
- `201`: Created (POST)
- `204`: No Content (DELETE)
- `400`: Bad Request / Validation
- `401`: Unauthorized
- `403`: Forbidden
- `404`: Not Found
- `409`: Conflict (duplicate)
- `410`: Gone (expired)
- `500`: Server Error

---

## Security Features

### Password Security

- **Algorithm**: bcrypt, salt rounds = 10
- **Storage**: Only hashed passwords
- **Comparison**: bcrypt.compare()

### Token Security

- Verification/reset tokens: 32 random bytes (hex)
- JWT secret in environment
- 7-day expiration enforced

### Protection Measures

- Email enumeration prevention
- Input sanitization & HTML escaping
- Email normalization
- JSON validation
- Automatic token expiration

---

## Environment Variables (Complete)

```bash
# Server
PORT=3001

# Database
DATABASE_URL="postgresql://user:pass@localhost:5432/db"

# JWT
JWT_SECRET="your-secret-key"

# AWS S3
AWS_REGION="us-east-1"
AWS_ACCESS_KEY_ID="your-key"
AWS_SECRET_ACCESS_KEY="your-secret"
AWS_S3_BUCKET_NAME="your-bucket"

# Gmail OAuth
EMAIL_USER="your-email@gmail.com"
GMAIL_CLIENT_ID="your-client-id"
GMAIL_CLIENT_SECRET="your-client-secret"
GMAIL_REFRESH_TOKEN="your-refresh-token"
EMAIL_FROM="Voces <email@gmail.com>"
```

---

## Pagination Details

### Implementation

- **Page**: 1-indexed
- **Limit**: Capped at 100
- **Skip**: (page - 1) × limit
- **Total Pages**: ceil(totalCount / limit)

### Metadata

- `currentPage`: Current page number
- `totalPages`: Total pages
- `totalCount`: Total matching records
- `limit`: Applied limit
- `hasNextPage`: Boolean
- `hasPreviousPage`: Boolean

---

## User Journey Examples

### New User

1. **POST** `/auth/register` → Receive confirmation
2. Check email → Click verification link
3. **POST** `/auth/verify-email/:token` → Account activated
4. **POST** `/auth/login` → Get JWT token
5. **GET** `/recordings` → Browse recordings
6. **GET** `/recordings/:id` → View details

### Returning User

1. **POST** `/auth/login` → Get token
2. **GET** `/recordings?search=nature` → Search
3. **GET** `/recordings/:id` → View specific recording

### Password Recovery

1. **POST** `/auth/forgot-password` → Request reset
2. Check email → Click reset link
3. **POST** `/auth/reset-password/:token` → Set new password
4. **POST** `/auth/login` → Login with new password

---

## Best Practices for Consumers

### Authentication

- Store JWT securely (sessionStorage/localStorage)
- Include in all protected requests
- Handle 401 by redirecting to login
- Implement token refresh logic

### Error Handling

- Check HTTP status codes
- Parse error messages
- Handle validation error arrays
- Show user-friendly messages
- Retry on 500 errors

### Performance

- Implement debouncing for search
- Cache frequently accessed data
- Use pagination (don't fetch all)
- Preload next page
- Optimize media loading

---

## Limitations

1. **File Type Validation**: None (accepts any extension)
2. **File Size Limit**: Not enforced at API level
3. **Rate Limiting**: Not implemented
4. **CORS**: Accepts all origins
5. **Email Resend**: No mechanism for expired verifications
6. **Search**: No fuzzy matching or relevance scoring

---

## Development Commands

```bash
npm install           # Install dependencies
npm run dev          # Development with hot reload
npm run build        # Build TypeScript
npm start            # Production server
npm test             # Run tests

npx prisma generate  # Generate Prisma Client
npx prisma migrate dev  # Run migrations
npx prisma studio    # Database GUI
```

---

## Metadata System

Recordings support flexible JSON metadata:

```json
{
  "duration": "120",
  "bitrate": "320kbps",
  "format": "mp3",
  "location": "Amazon Rainforest",
  "recordedDate": "2025-01-15",
  "equipment": "Rode NTG5",
  "species": "Harpy Eagle"
}
```

No enforced schema - allows custom fields per recording.

---

## Troubleshooting

**"Not authorized, no token"**

- Add `Authorization: Bearer <token>` header
- Check token hasn't expired (7 days)

**"Please verify your email"**

- Complete email verification step
- Check spam folder for verification email

**"Invalid or expired token"**

- Request new verification/reset email
- Tokens expire in 1 hour

**File upload fails**

- Use `multipart/form-data` content type
- Field name must be `recording`
- Tags should be JSON string array
- Metadata should be JSON string

---

## Success Checklist

✅ JWT token stored securely  
✅ Authorization header included  
✅ File uploads use multipart/form-data  
✅ Pagination implemented  
✅ Error responses handled  
✅ Email verification flow clear  
✅ Password requirements communicated  
✅ Audio files playable via fileUrl  
✅ Search with debouncing  
✅ Loading states shown  
✅ Token expiration handled

---

_For admin-specific endpoints and operations, refer to separate admin documentation._
