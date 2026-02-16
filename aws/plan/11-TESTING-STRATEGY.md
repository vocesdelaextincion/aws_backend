# Part 11: Testing Strategy

## Goal

Define the testing approach for the AWS serverless architecture, covering local development, unit tests, integration tests, and end-to-end testing. Ensure code quality and catch issues before deployment.

---

## Testing Pyramid

```
           ┌─────────────┐
           │   E2E Tests │  (Few, slow, high confidence)
           └─────────────┘
         ┌─────────────────┐
         │ Integration Tests│  (Some, medium speed)
         └─────────────────┘
      ┌───────────────────────┐
      │     Unit Tests        │  (Many, fast, focused)
      └───────────────────────┘
```

---

## Unit Tests

### Scope

Test individual functions in isolation — business logic, validation, data transformations, utility functions.

### Tools

- **Test runner**: Jest (already in use in legacy)
- **Assertion library**: Jest built-in
- **Mocking**: Jest mocks for AWS SDK calls

### What to test

| Component | Test Coverage |
|---|---|
| Input validation (Zod schemas) | Valid inputs pass, invalid inputs fail with correct error messages |
| Business logic functions | Edge cases, error handling, data transformations |
| Response helpers | Correct status codes and body formatting |
| Utility functions (S3, DynamoDB helpers) | Mock AWS SDK, verify correct parameters passed |
| Access control logic | `canAccessRecording()`, `requireAdmin()`, plan-based checks |

### Example: Testing a validation schema

```typescript
// __tests__/validation/recording.test.ts
import { createRecordingSchema } from '../shared/validation';

describe('createRecordingSchema', () => {
  it('should accept valid recording data', () => {
    const valid = {
      title: 'Jaguar Roar',
      description: 'A powerful roar',
      isFree: false,
      tags: ['mammal', 'carnivore'],
    };
    expect(() => createRecordingSchema.parse(valid)).not.toThrow();
  });

  it('should reject missing title', () => {
    const invalid = { description: 'No title' };
    expect(() => createRecordingSchema.parse(invalid)).toThrow();
  });

  it('should reject title longer than 200 characters', () => {
    const invalid = { title: 'a'.repeat(201) };
    expect(() => createRecordingSchema.parse(invalid)).toThrow();
  });
});
```

### Example: Testing business logic with mocked AWS SDK

```typescript
// __tests__/recordings/get.test.ts
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { getRecordingById } from '../recordings/get';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

describe('getRecordingById', () => {
  it('should return recording if found', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { PK: 'REC#123', title: 'Test', isFree: true },
    });

    const result = await getRecordingById('123');
    expect(result).toEqual({ PK: 'REC#123', title: 'Test', isFree: true });
  });

  it('should return null if not found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await getRecordingById('123');
    expect(result).toBeNull();
  });
});
```

### Running unit tests

```bash
# In aws/lambdas/
npm test

# With coverage
npm test -- --coverage

# Watch mode during development
npm test -- --watch
```

### Coverage targets

- **Minimum**: 70% overall
- **Critical paths** (auth, access control): 90%+
- **Utility functions**: 80%+

---

## Integration Tests

### Scope

Test Lambda functions with real AWS services (DynamoDB, S3, Cognito) in a dev environment. Verify that the Lambda → AWS service integration works correctly.

### Approach

**Option A: Local AWS services**
- Use **DynamoDB Local** for database tests
- Use **LocalStack** for S3, SES (community edition)
- Mock Cognito (no local equivalent)

**Option B: Real dev environment**
- Deploy to actual AWS dev environment
- Run tests against real DynamoDB table, S3 bucket, Cognito pool
- Clean up test data after each run

**Recommendation**: Start with **Option A** for fast feedback during development. Add **Option B** for pre-deployment validation in CI/CD.

### DynamoDB Local Setup

```bash
# Install DynamoDB Local
npm install --save-dev @aws-sdk/client-dynamodb dynamodb-local

# Start DynamoDB Local (in docker)
docker run -p 8000:8000 amazon/dynamodb-local

# Or via npm script
npx dynamodb-local start
```

### Example: Integration test with DynamoDB Local

```typescript
// __tests__/integration/recordings.test.ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({
  endpoint: 'http://localhost:8000',
  region: 'local',
  credentials: { accessKeyId: 'dummy', secretAccessKey: 'dummy' },
});
const docClient = DynamoDBDocumentClient.from(client);

describe('Recording CRUD (DynamoDB Local)', () => {
  beforeAll(async () => {
    // Create test table (or use a setup script)
  });

  afterEach(async () => {
    // Clean up test data
  });

  it('should create and retrieve a recording', async () => {
    const recording = {
      PK: 'REC#test-123',
      SK: 'REC#test-123',
      title: 'Test Recording',
      isFree: true,
      entity: 'RECORDING',
    };

    await docClient.send(new PutCommand({
      TableName: 'test-table',
      Item: recording,
    }));

    const result = await docClient.send(new GetCommand({
      TableName: 'test-table',
      Key: { PK: 'REC#test-123', SK: 'REC#test-123' },
    }));

    expect(result.Item).toMatchObject(recording);
  });
});
```

### Running integration tests

```bash
# Start DynamoDB Local
docker-compose up -d dynamodb-local

# Run integration tests
npm run test:integration

# Stop services
docker-compose down
```

---

## Lambda Handler Tests

### Scope

Test the full Lambda handler with mocked API Gateway events. Verify routing, request parsing, response formatting.

### Example: Testing the auth Lambda handler

```typescript
// __tests__/handlers/auth.test.ts
import { handler } from '../auth/handler';
import { APIGatewayProxyEventV2 } from 'aws-lambda';

describe('Auth Lambda Handler', () => {
  it('should route POST /auth/register to register handler', async () => {
    const event: APIGatewayProxyEventV2 = {
      version: '2.0',
      routeKey: 'POST /auth/register',
      rawPath: '/auth/register',
      requestContext: {
        http: { method: 'POST', path: '/auth/register' },
      } as any,
      body: JSON.stringify({ email: 'test@example.com', password: 'password123' }),
    } as any;

    const response = await handler(event);
    expect(response.statusCode).toBe(201);
  });

  it('should return 404 for unknown route', async () => {
    const event: APIGatewayProxyEventV2 = {
      version: '2.0',
      routeKey: 'GET /auth/unknown',
      rawPath: '/auth/unknown',
      requestContext: {
        http: { method: 'GET', path: '/auth/unknown' },
      } as any,
    } as any;

    const response = await handler(event);
    expect(response.statusCode).toBe(404);
  });
});
```

---

## End-to-End Tests

### Scope

Test the full API flow from client → API Gateway → Lambda → DynamoDB/S3/Cognito → response. Run against a deployed dev environment.

### Tools

**Option A: Postman/Newman**
- Create Postman collection with all endpoints
- Run via Newman in CI/CD
- Good for manual testing and automated regression

**Option B: Playwright/Cypress API testing**
- Write E2E tests in TypeScript
- Better integration with existing test suite
- Can test frontend + backend together

**Recommendation**: Start with **Postman** for quick setup, migrate to **Playwright** if frontend E2E tests are added.

### Example: E2E test flow

```
1. POST /auth/register → Create user in Cognito + DynamoDB
2. POST /auth/verify-email → Verify with code (mocked email)
3. POST /auth/login → Get access token
4. GET /auth/me → Verify user profile (with token)
5. POST /recordings → Create recording (admin only, expect 403 for regular user)
6. GET /recordings → List recordings
7. Cleanup: DELETE user, recording
```

### Running E2E tests

```bash
# Against dev environment
npm run test:e2e -- --env dev

# Against local API (if using SAM local)
npm run test:e2e -- --env local
```

---

## Local Development & Testing

### SAM Local (Optional)

AWS SAM CLI can run Lambda functions locally with API Gateway emulation.

```bash
# Install SAM CLI
brew install aws-sam-cli

# Start local API
sam local start-api --template-file cdk.out/ApiStack.template.json

# Invoke a specific function
sam local invoke AuthFunction --event events/register.json
```

**Pros**:
- Test Lambda handlers locally without deploying
- Fast iteration

**Cons**:
- Requires SAM template (CDK can generate it)
- Still needs real AWS services (DynamoDB, Cognito) or mocks

**Recommendation**: Use for debugging specific Lambda issues. Not required for everyday development.

### Testing Cognito Flows Locally

Cognito has no local equivalent. Options:

**Option A**: Use a dedicated dev Cognito User Pool
- Create users, verify emails, test auth flows
- Clean up test users after tests

**Option B**: Mock Cognito SDK calls in tests
- Fast, no AWS dependency
- Doesn't test actual Cognito behavior

**Recommendation**: **Option B** for unit tests, **Option A** for integration/E2E tests.

---

## CI/CD Testing Pipeline

### GitHub Actions Workflow

```yaml
# .github/workflows/ci.yml
name: CI

on: [pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: |
          cd aws/lambdas
          npm ci
      
      - name: Lint
        run: npm run lint
      
      - name: Unit tests
        run: npm test -- --coverage
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
      
      - name: Start DynamoDB Local
        run: docker run -d -p 8000:8000 amazon/dynamodb-local
      
      - name: Integration tests
        run: npm run test:integration
      
      - name: CDK synth (validate templates)
        run: |
          cd aws/infra
          npm ci
          npx cdk synth
```

### Pre-deployment E2E Tests

```yaml
# .github/workflows/deploy-infra.yml (excerpt)
- name: E2E tests against dev
  if: github.ref == 'refs/heads/main'
  run: |
    npm run test:e2e -- --env dev
  env:
    API_URL: ${{ steps.deploy.outputs.api_url }}
```

---

## Test Data Management

### Seeding Test Data

For integration and E2E tests, seed data is needed:

```typescript
// scripts/seed-test-data.ts
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

export async function seedTestData(docClient: DynamoDBDocumentClient, tableName: string) {
  // Create test admin user
  await docClient.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: 'USER#test-admin',
      SK: 'USER#test-admin',
      email: 'admin@test.com',
      role: 'ADMIN',
      plan: 'PREMIUM',
      entity: 'USER',
    },
  }));

  // Create test recordings
  await docClient.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: 'REC#test-1',
      SK: 'REC#test-1',
      title: 'Test Recording 1',
      isFree: true,
      entity: 'RECORDING',
    },
  }));

  // Create test tags
  // ...
}
```

### Cleanup

```typescript
// scripts/cleanup-test-data.ts
export async function cleanupTestData(docClient: DynamoDBDocumentClient, tableName: string) {
  // Delete all items with PK starting with 'test-'
  // Use Scan + BatchWriteItem
}
```

---

## Definition of Done

- [ ] Unit test suite set up with Jest
- [ ] Unit tests written for validation schemas (Zod)
- [ ] Unit tests written for business logic functions
- [ ] AWS SDK calls mocked in unit tests
- [ ] Integration tests set up with DynamoDB Local
- [ ] Lambda handler tests verify routing and response formatting
- [ ] E2E test suite created (Postman or Playwright)
- [ ] E2E tests cover critical flows (register → verify → login → CRUD)
- [ ] CI/CD pipeline runs unit + integration tests on every PR
- [ ] Pre-deployment E2E tests run against dev before prod deploy
- [ ] Test coverage meets targets (70% overall, 90% critical paths)
- [ ] Test data seeding and cleanup scripts created
- [ ] Documentation on running tests locally added to README

---

## Future Enhancements

- **Load testing**: Use Artillery or k6 to test API under load
- **Security testing**: OWASP ZAP or Burp Suite for vulnerability scanning
- **Contract testing**: Pact for frontend-backend contract validation
- **Chaos engineering**: AWS Fault Injection Simulator for resilience testing
