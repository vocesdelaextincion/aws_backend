import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import { protect, admin } from '../../src/middleware/auth.middleware';
import prisma from '../../src/config/prisma';

// Mock dependencies
jest.mock('jsonwebtoken');
jest.mock('../../src/config/prisma', () => ({
  user: {
    findUnique: jest.fn(),
  },
}));

describe('Auth Middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequest = {
      headers: {},
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    process.env.JWT_SECRET = 'test-secret'; // Set a default secret for tests
  });

  describe('protect middleware', () => {
    it('should return 401 if no token is provided', async () => {
      await protect(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Not authorized, no token' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 if token does not start with Bearer', async () => {
      mockRequest.headers!.authorization = 'invalid-token';
      await protect(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Not authorized, no token' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 500 if JWT_SECRET is not configured', async () => {
      delete process.env.JWT_SECRET;
      mockRequest.headers!.authorization = 'Bearer valid-token';
      await protect(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Server error: JWT secret not configured.' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 if token is invalid', async () => {
      mockRequest.headers!.authorization = 'Bearer invalid-token';
      (jwt.verify as jest.Mock).mockImplementation(() => {
        throw new Error('Invalid token');
      });
      await protect(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Not authorized, token failed' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 if user is not found', async () => {
      mockRequest.headers!.authorization = 'Bearer valid-token';
      (jwt.verify as jest.Mock).mockReturnValue({ id: '1' });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await protect(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Not authorized, user not found' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should call next and attach user to request on success', async () => {
      const mockUser = { id: '1', email: 'test@test.com', role: 'USER' };
      mockRequest.headers!.authorization = 'Bearer valid-token';
      (jwt.verify as jest.Mock).mockReturnValue({ id: '1' });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      await protect(mockRequest as Request, mockResponse as Response, mockNext);

      expect(jwt.verify).toHaveBeenCalledWith('valid-token', 'test-secret');
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: '1' },
        select: {
          id: true,
          email: true,
          plan: true,
          role: true,
          isVerified: true,
        },
      });
      expect((mockRequest as any).user).toEqual(mockUser);
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('admin middleware', () => {
    it('should call next if user is an admin', () => {
      (mockRequest as any).user = { role: 'ADMIN' };
      admin(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should return 403 if user is not an admin', () => {
      (mockRequest as any).user = { role: 'USER' };
      admin(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockResponse.status).toHaveBeenCalledWith(403);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Not authorized as an admin' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 403 if there is no user on the request', () => {
      admin(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockResponse.status).toHaveBeenCalledWith(403);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Not authorized as an admin' });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });
});
