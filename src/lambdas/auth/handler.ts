import { APIGatewayProxyEventV2, APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
  ConfirmSignUpCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  NotAuthorizedException,
  UsernameExistsException,
  CodeMismatchException,
  ExpiredCodeException,
  UserNotConfirmedException,
  InvalidPasswordException,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from '../shared/db';
import { ok, created, badRequest, unauthorized, forbidden, notFound, internalError } from '../shared/response';

const cognito = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.COGNITO_CLIENT_ID!;

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
}

async function getUserFromDynamo(sub: string) {
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${sub}`, SK: `USER#${sub}` },
  }));
  return result.Item;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const route = `${event.requestContext.http.method} ${event.rawPath}`;

  try {
    switch (route) {
      case 'POST /auth/register':        return await register(event);
      case 'POST /auth/login':           return await login(event);
      case 'POST /auth/verify-email':    return await verifyEmail(event);
      case 'POST /auth/forgot-password': return await forgotPassword(event);
      case 'POST /auth/reset-password':  return await resetPassword(event);
      case 'GET /auth/me':               return await me(event);
      default: return notFound();
    }
  } catch (err) {
    console.error('Unhandled error in auth handler:', err);
    return internalError();
  }
}

async function register(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let body: { email?: string; password?: string };
  try { body = JSON.parse(event.body ?? '{}'); } catch { return badRequest('Invalid JSON'); }

  const { email, password } = body;
  if (!email || !password) return badRequest('email and password are required');

  try {
    const result = await cognito.send(new SignUpCommand({
      ClientId: CLIENT_ID,
      Username: email,
      Password: password,
      UserAttributes: [{ Name: 'email', Value: email }],
    }));

    const sub = result.UserSub!;
    const now = new Date().toISOString();

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `USER#${sub}`,
        SK: `USER#${sub}`,
        GSI1PK: `USEREMAIL#${email.toLowerCase()}`,
        GSI1SK: `USER#${sub}`,
        email: email.toLowerCase(),
        plan: 'FREE',
        role: 'USER',
        createdAt: now,
        updatedAt: now,
        entity: 'USER',
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));

    return created({ message: 'Registration successful. Please check your email for a verification code.' });
  } catch (err) {
    if (err instanceof UsernameExistsException) return badRequest('An account with this email already exists');
    if (err instanceof InvalidPasswordException) return badRequest(err.message ?? 'Password does not meet requirements');
    throw err;
  }
}

async function login(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let body: { email?: string; password?: string };
  try { body = JSON.parse(event.body ?? '{}'); } catch { return badRequest('Invalid JSON'); }

  const { email, password } = body;
  if (!email || !password) return badRequest('email and password are required');

  try {
    const result = await cognito.send(new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }));

    const tokens = result.AuthenticationResult!;
    const claims = decodeJwtPayload(tokens.IdToken!);
    const sub = claims.sub as string;

    const userItem = await getUserFromDynamo(sub);

    return ok({
      message: 'Login successful',
      token: tokens.IdToken,
      refreshToken: tokens.RefreshToken,
      user: {
        id: sub,
        email: userItem?.email ?? email,
        role: userItem?.role ?? 'USER',
        plan: userItem?.plan ?? 'FREE',
      },
    });
  } catch (err) {
    if (err instanceof NotAuthorizedException) return unauthorized('Invalid email or password');
    if (err instanceof UserNotConfirmedException) return forbidden('Email not verified. Please check your email for a verification code.');
    throw err;
  }
}

async function verifyEmail(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let body: { email?: string; code?: string };
  try { body = JSON.parse(event.body ?? '{}'); } catch { return badRequest('Invalid JSON'); }

  const { email, code } = body;
  if (!email || !code) return badRequest('email and code are required');

  try {
    await cognito.send(new ConfirmSignUpCommand({
      ClientId: CLIENT_ID,
      Username: email,
      ConfirmationCode: code,
    }));

    return ok({ message: 'Email verified successfully' });
  } catch (err) {
    if (err instanceof CodeMismatchException) return badRequest('Invalid verification code');
    if (err instanceof ExpiredCodeException) return badRequest('Verification code has expired. Please request a new one.');
    if (err instanceof NotAuthorizedException) return badRequest('Email is already verified');
    throw err;
  }
}

async function forgotPassword(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let body: { email?: string };
  try { body = JSON.parse(event.body ?? '{}'); } catch { return badRequest('Invalid JSON'); }

  const { email } = body;
  if (!email) return badRequest('email is required');

  // Always succeed — prevents email enumeration.
  try {
    await cognito.send(new ForgotPasswordCommand({ ClientId: CLIENT_ID, Username: email }));
  } catch { /* intentionally swallowed */ }

  return ok({ message: 'If an account exists with this email, a password reset code has been sent.' });
}

async function resetPassword(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let body: { email?: string; code?: string; newPassword?: string };
  try { body = JSON.parse(event.body ?? '{}'); } catch { return badRequest('Invalid JSON'); }

  const { email, code, newPassword } = body;
  if (!email || !code || !newPassword) return badRequest('email, code, and newPassword are required');

  try {
    await cognito.send(new ConfirmForgotPasswordCommand({
      ClientId: CLIENT_ID,
      Username: email,
      ConfirmationCode: code,
      Password: newPassword,
    }));

    return ok({ message: 'Password reset successfully' });
  } catch (err) {
    if (err instanceof CodeMismatchException) return badRequest('Invalid reset code');
    if (err instanceof ExpiredCodeException) return badRequest('Reset code has expired. Please request a new one.');
    if (err instanceof InvalidPasswordException) return badRequest(err.message ?? 'Password does not meet requirements');
    throw err;
  }
}

async function me(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const sub = (event as APIGatewayProxyEventV2WithJWTAuthorizer).requestContext.authorizer.jwt.claims.sub as string | undefined;
  if (!sub) return unauthorized();

  const userItem = await getUserFromDynamo(sub);
  if (!userItem) return notFound('User not found');

  return ok({
    id: sub,
    email: userItem.email,
    role: userItem.role,
    plan: userItem.plan,
    createdAt: userItem.createdAt,
  });
}
