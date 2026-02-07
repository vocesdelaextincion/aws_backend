import { Request, Response, NextFunction } from 'express';
import { register, login, verifyEmail, forgotPassword, resetPassword } from '../../src/controllers/auth.controller';
import prisma from '../../src/config/prisma';
import bcrypt from 'bcrypt';
import sendEmail from '../../src/utils/email';
import { generateToken } from '../../src/utils/jwt';
import crypto from 'crypto';

// Mock dependencies
jest.mock('../../src/config/prisma', () => ({
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findFirst: jest.fn(),
  },
}));
jest.mock('bcrypt');
jest.mock('../../src/utils/email');
jest.mock('../../src/utils/jwt');
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomBytes: jest.fn(),
}));

describe('Auth Controller - Register', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction = jest.fn();

  beforeEach(() => {
    // Reset mocks before each test
    jest.clearAllMocks();

    mockRequest = {
      body: {
        email: 'test@example.com',
        password: 'password123',
      },
    };

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  });

  it('should return 409 if user already exists', async () => {
    // Arrange
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: '1', email: 'test@example.com' });

    // Act
    await register(mockRequest as Request, mockResponse as Response, mockNext);

    // Assert
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'test@example.com' } });
    expect(mockResponse.status).toHaveBeenCalledWith(409);
    expect(mockResponse.json).toHaveBeenCalledWith({ message: 'User with this email already exists' });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('should create a new user and send a verification email', async () => {
    // Arrange
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    (bcrypt.hash as jest.Mock).mockResolvedValue('hashedPassword');
    const mockNewUser = {
      id: '2',
      email: 'newuser@example.com',
      password: 'hashedPassword',
      plan: 'FREE',
      role: 'USER',
    };
    (prisma.user.create as jest.Mock).mockResolvedValue(mockNewUser);
    (sendEmail as jest.Mock).mockResolvedValue(undefined);
    (crypto.randomBytes as jest.Mock).mockReturnValue({ toString: () => 'mock-verification-token' });

    mockRequest.body.email = 'newuser@example.com';

    // Act
    await register(mockRequest as Request, mockResponse as Response, mockNext);

    // Assert
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'newuser@example.com' } });
    expect(bcrypt.hash).toHaveBeenCalledWith('password123', 10);
    expect(prisma.user.create).toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalled();
    expect(mockResponse.status).toHaveBeenCalledWith(201);
    expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'User created successfully. Please verify your email.',
      user: {
        id: mockNewUser.id,
        email: mockNewUser.email,
        plan: mockNewUser.plan,
        role: mockNewUser.role,
      },
    }));
  });
});

describe('Auth Controller - Login', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    mockRequest = {
      body: {
        email: 'test@example.com',
        password: 'password123',
      },
    };

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  });

  it('should return 401 if user is not found', async () => {
    // Arrange
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    // Act
    await login(mockRequest as Request, mockResponse as Response, mockNext);

    // Assert
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'test@example.com' } });
    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Invalid credentials' });
  });

  it('should return 401 if password does not match', async () => {
    // Arrange
    const mockUser = { id: '1', email: 'test@example.com', password: 'hashedPassword', isVerified: true };
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    // Act
    await login(mockRequest as Request, mockResponse as Response, mockNext);

    // Assert
    expect(bcrypt.compare).toHaveBeenCalledWith('password123', 'hashedPassword');
    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Invalid credentials' });
  });

  it('should return 403 if user is not verified', async () => {
    // Arrange
    const mockUser = { id: '1', email: 'test@example.com', password: 'hashedPassword', isVerified: false };
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    // Act
    await login(mockRequest as Request, mockResponse as Response, mockNext);

    // Assert
    expect(mockResponse.status).toHaveBeenCalledWith(403);
    expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Please verify your email before logging in.' });
  });

  it('should return 200 and a token on successful login', async () => {
    // Arrange
    const mockUser = { id: '1', email: 'test@example.com', password: 'hashedPassword', isVerified: true, plan: 'FREE', role: 'USER' };
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    (generateToken as jest.Mock).mockReturnValue('fake-jwt-token');

    // Act
    await login(mockRequest as Request, mockResponse as Response, mockNext);

    // Assert
    expect(generateToken).toHaveBeenCalledWith({ id: mockUser.id, role: mockUser.role });
    expect(mockResponse.status).toHaveBeenCalledWith(200);
    expect(mockResponse.json).toHaveBeenCalledWith({
      message: 'Login successful',
      token: 'fake-jwt-token',
      user: {
        id: mockUser.id,
        email: mockUser.email,
        plan: mockUser.plan,
        role: mockUser.role,
      },
    });
  });
});

describe('Auth Controller - Verify Email', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    mockRequest = {
      params: {},
    };

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  });

  it('should return 400 if token is not provided', async () => {
    // Arrange
    mockRequest.params = { token: '' };

    // Act
    await verifyEmail(mockRequest as Request, mockResponse as Response, mockNext);

    // Assert
    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Verification token is required.' });
  });

  it('should return 404 if token is invalid', async () => {
    // Arrange
    mockRequest.params = { token: 'invalid-token' };
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    // Act
    await verifyEmail(mockRequest as Request, mockResponse as Response, mockNext);

    // Assert
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { emailVerificationToken: 'invalid-token' } });
    expect(mockResponse.status).toHaveBeenCalledWith(404);
    expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Invalid verification token.' });
  });

  it('should return 410 if token has expired', async () => {
    // Arrange
    const expiredDate = new Date(Date.now() - 1000);
    const mockUser = { id: '1', emailVerificationTokenExpires: expiredDate };
    mockRequest.params = { token: 'expired-token' };
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

    // Act
    await verifyEmail(mockRequest as Request, mockResponse as Response, mockNext);

    // Assert
    expect(mockResponse.status).toHaveBeenCalledWith(410);
    expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Verification token has expired.' });
  });

  it('should verify email and return 200 on success', async () => {
    // Arrange
    const validDate = new Date(Date.now() + 3600000);
    const mockUser = { id: '1', emailVerificationTokenExpires: validDate };
    mockRequest.params = { token: 'valid-token' };
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (prisma.user.update as jest.Mock).mockResolvedValue({});

    // Act
    await verifyEmail(mockRequest as Request, mockResponse as Response, mockNext);

    // Assert
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: mockUser.id },
      data: {
        isVerified: true,
        emailVerificationToken: null,
        emailVerificationTokenExpires: null,
      },
    });
    expect(mockResponse.status).toHaveBeenCalledWith(200);
    expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Email verified successfully. You can now log in.' });
  });
});

describe('Auth Controller - Forgot Password', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    mockRequest = {
      body: {
        email: 'test@example.com',
      },
    };

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  });

  it('should return 200 and a generic message if user is not found', async () => {
    // Arrange
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    // Act
    await forgotPassword(mockRequest as Request, mockResponse as Response, mockNext);

    // Assert
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'test@example.com' } });
    expect(mockResponse.status).toHaveBeenCalledWith(200);
    expect(mockResponse.json).toHaveBeenCalledWith({ message: 'If a user with that email exists, a password reset link has been sent.' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('should update user with reset token and send email if user is found', async () => {
    // Arrange
    const mockUser = { id: '1', email: 'test@example.com' };
    const resetToken = 'mock-reset-token';
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (crypto.randomBytes as jest.Mock).mockReturnValue({ toString: () => resetToken });
    (prisma.user.update as jest.Mock).mockResolvedValue({});
    (sendEmail as jest.Mock).mockResolvedValue(undefined);

    // Act
    await forgotPassword(mockRequest as Request, mockResponse as Response, mockNext);

    // Assert
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: 'test@example.com' },
      data: {
        passwordResetToken: resetToken,
        passwordResetTokenExpires: expect.any(Date),
      },
    }));
    expect(sendEmail).toHaveBeenCalled();
    expect(mockResponse.status).toHaveBeenCalledWith(200);
    expect(mockResponse.json).toHaveBeenCalledWith({ message: 'If a user with that email exists, a password reset link has been sent.' });
  });

  it('should still return 200 if sending email fails', async () => {
    // Arrange
    const mockUser = { id: '1', email: 'test@example.com' };
    const resetToken = 'mock-reset-token';
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (crypto.randomBytes as jest.Mock).mockReturnValue({ toString: () => resetToken });
    (prisma.user.update as jest.Mock).mockResolvedValue({});
    (sendEmail as jest.Mock).mockRejectedValue(new Error('Email failed'));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // Act
    await forgotPassword(mockRequest as Request, mockResponse as Response, mockNext);

    // Assert
    expect(sendEmail).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to send password reset email:', expect.any(Error));
    expect(mockResponse.status).toHaveBeenCalledWith(200);
    expect(mockResponse.json).toHaveBeenCalledWith({ message: 'If a user with that email exists, a password reset link has been sent.' });

    // Clean up spy
    consoleErrorSpy.mockRestore();
  });
});

describe('Auth Controller - Reset Password', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    mockRequest = {
      params: { token: 'valid-token' },
      body: { password: 'newPassword123' },
    };

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  });

  it('should return 400 if token is invalid or expired', async () => {
    // Arrange
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);

    // Act
    await resetPassword(mockRequest as Request, mockResponse as Response, mockNext);

    // Assert
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        passwordResetToken: 'valid-token',
        passwordResetTokenExpires: { gt: expect.any(Date) },
      },
    });
    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Invalid or expired password reset token.' });
  });

  it('should reset password and return 200 on success', async () => {
    // Arrange
    const mockUser = { id: '1' };
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(mockUser);
    (bcrypt.hash as jest.Mock).mockResolvedValue('newHashedPassword');
    (prisma.user.update as jest.Mock).mockResolvedValue({});

    // Act
    await resetPassword(mockRequest as Request, mockResponse as Response, mockNext);

    // Assert
    expect(bcrypt.hash).toHaveBeenCalledWith('newPassword123', 10);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: mockUser.id },
      data: {
        password: 'newHashedPassword',
        passwordResetToken: null,
        passwordResetTokenExpires: null,
      },
    });
    expect(mockResponse.status).toHaveBeenCalledWith(200);
    expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Password has been reset successfully.' });
  });
});
