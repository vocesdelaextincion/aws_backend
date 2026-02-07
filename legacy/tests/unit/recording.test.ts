import { Request, Response, NextFunction } from 'express';
import {
  getRecordings,
  getRecordingById,
  createRecording,
  updateRecording,
  deleteRecording,
} from '../../src/controllers/recording.controller';
import prisma from '../../src/config/prisma';
import { uploadToS3, deleteS3Object } from '../../src/utils/s3';
import { randomUUID } from 'crypto';

// Mock dependencies
jest.mock('../../src/config/prisma', () => ({
  recording: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  tag: {
    upsert: jest.fn(),
  },
}));
jest.mock('../../src/utils/s3');
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: jest.fn(),
}));

describe('Recording Controller', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequest = {
      params: {},
      body: {},
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      send: jest.fn(),
    };
  });

  describe('getRecordings', () => {
    it('should return all recordings and sort them by creation date', async () => {
      const mockRecordings = [
        { id: '1', title: 'Test Recording 1', createdAt: new Date('2023-01-01') },
        { id: '2', title: 'Test Recording 2', createdAt: new Date('2023-01-02') },
      ];
      (prisma.recording.findMany as jest.Mock).mockResolvedValue(mockRecordings);

      await getRecordings(mockRequest as Request, mockResponse as Response, mockNext);

      expect(prisma.recording.findMany).toHaveBeenCalledWith({
        orderBy: {
          createdAt: 'desc',
        },
      });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith(mockRecordings);
    });
  });

  describe('getRecordingById', () => {
    it('should return a single recording with its tags', async () => {
      mockRequest.params = { id: '1' };
      const mockRecording = { 
        id: '1', 
        title: 'Test Recording', 
        tags: [{ id: 't1', name: 'test' }]
      };
      (prisma.recording.findUnique as jest.Mock).mockResolvedValue(mockRecording);

      await getRecordingById(mockRequest as Request, mockResponse as Response, mockNext);

      expect(prisma.recording.findUnique).toHaveBeenCalledWith({
        where: { id: '1' },
        include: { tags: true },
      });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith(mockRecording);
    });

    it('should return 404 if recording is not found', async () => {
      mockRequest.params = { id: '1' };
      (prisma.recording.findUnique as jest.Mock).mockResolvedValue(null);

      await getRecordingById(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Recording not found' });
    });
  });

  describe('createRecording', () => {
    beforeEach(() => {
      mockRequest.body = { title: 'New Recording', description: 'A test file', tags: ['test', 'audio'] };
      mockRequest.file = {
        originalname: 'test.mp3',
        buffer: Buffer.from('test audio'),
      } as Express.Multer.File;
      process.env.AWS_S3_BUCKET_NAME = 'test-bucket';
      (randomUUID as jest.Mock).mockReturnValue('mock-uuid');
      (uploadToS3 as jest.Mock).mockResolvedValue({ fileUrl: 'http://s3.com/mock-uuid.mp3', fileKey: 'mock-uuid.mp3' });
    });

    it('should create a recording, connect or create tags, and upload the file', async () => {
      const newRecording = { id: '1', ...mockRequest.body };
      (prisma.recording.create as jest.Mock).mockResolvedValue(newRecording);

      await createRecording(mockRequest as Request, mockResponse as Response, mockNext);

      expect(uploadToS3).toHaveBeenCalledWith('test-bucket', 'mock-uuid.mp3', mockRequest.file!.buffer);
      expect(prisma.recording.create).toHaveBeenCalledWith({
        data: {
          title: 'New Recording',
          description: 'A test file',
          fileUrl: 'http://s3.com/mock-uuid.mp3',
          fileKey: 'mock-uuid.mp3',
          tags: {
            connectOrCreate: [
              { where: { name: 'test' }, create: { name: 'test' } },
              { where: { name: 'audio' }, create: { name: 'audio' } },
            ],
          },
        },
        include: {
          tags: true,
        },
      });
      expect(mockResponse.status).toHaveBeenCalledWith(201);
      expect(mockResponse.json).toHaveBeenCalledWith(newRecording);
    });

    it('should return 400 if title is missing', async () => {
      mockRequest.body.title = '';
      await createRecording(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Title and file are required.' });
    });

    it('should return 500 if S3 bucket name is not configured', async () => {
      delete process.env.AWS_S3_BUCKET_NAME;
      await createRecording(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'S3 bucket name not configured on server.' });
    });
  });

  describe('updateRecording', () => {
    beforeEach(() => {
      mockRequest.params = { id: '1' };
      mockRequest.body = { title: 'Updated Title', tags: ['updated'] };
      process.env.AWS_S3_BUCKET_NAME = 'test-bucket';
    });

    it('should return 404 if recording to update is not found', async () => {
      (prisma.recording.findUnique as jest.Mock).mockResolvedValue(null);
      await updateRecording(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Recording not found' });
    });

    it('should update recording details without a new file', async () => {
      const existingRecording = { id: '1', title: 'Old Title', fileKey: 'key' };
      (prisma.recording.findUnique as jest.Mock).mockResolvedValue(existingRecording);
      (prisma.tag.upsert as jest.Mock).mockResolvedValue({});
      (prisma.recording.update as jest.Mock).mockResolvedValue({ ...existingRecording, ...mockRequest.body });

      await updateRecording(mockRequest as Request, mockResponse as Response, mockNext);

      expect(prisma.tag.upsert).toHaveBeenCalledWith({ where: { name: 'updated' }, update: {}, create: { name: 'updated' } });
      expect(prisma.recording.update).toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(deleteS3Object).not.toHaveBeenCalled();
    });

    it('should update recording and replace the file', async () => {
      const existingRecording = { id: '1', title: 'Old Title', fileKey: 'old-key.mp3' };
      mockRequest.file = { originalname: 'new.mp3', buffer: Buffer.from('new audio') } as Express.Multer.File;
      (prisma.recording.findUnique as jest.Mock).mockResolvedValue(existingRecording);
      (randomUUID as jest.Mock).mockReturnValue('new-uuid');
      (uploadToS3 as jest.Mock).mockResolvedValue({ fileUrl: 'new-url', fileKey: 'new-key.mp3' });
      (prisma.recording.update as jest.Mock).mockResolvedValue({ id: '1' });

      await updateRecording(mockRequest as Request, mockResponse as Response, mockNext);

      expect(deleteS3Object).toHaveBeenCalledWith('test-bucket', 'old-key.mp3');
      expect(uploadToS3).toHaveBeenCalledWith('test-bucket', 'new-uuid.mp3', mockRequest.file!.buffer);
      expect(prisma.recording.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ fileKey: 'new-key.mp3' })
      }));
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });
  });

  describe('deleteRecording', () => {
    beforeEach(() => {
      mockRequest.params = { id: '1' };
      process.env.AWS_S3_BUCKET_NAME = 'test-bucket';
    });

    it('should return 404 if recording to delete is not found', async () => {
      (prisma.recording.findUnique as jest.Mock).mockResolvedValue(null);
      await deleteRecording(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Recording not found' });
    });

    it('should delete the recording and its S3 object', async () => {
      const existingRecording = { id: '1', fileKey: 'key-to-delete.mp3' };
      (prisma.recording.findUnique as jest.Mock).mockResolvedValue(existingRecording);
      (deleteS3Object as jest.Mock).mockResolvedValue({});
      (prisma.recording.delete as jest.Mock).mockResolvedValue({});

      await deleteRecording(mockRequest as Request, mockResponse as Response, mockNext);

      expect(deleteS3Object).toHaveBeenCalledWith('test-bucket', 'key-to-delete.mp3');
      expect(prisma.recording.delete).toHaveBeenCalledWith({ where: { id: '1' } });
      expect(mockResponse.status).toHaveBeenCalledWith(204);
      expect(mockResponse.send).toHaveBeenCalled();
    });

    it('should return 500 if bucket name is not configured', async () => {
      const existingRecording = { id: '1', fileKey: 'key.mp3' };
      (prisma.recording.findUnique as jest.Mock).mockResolvedValue(existingRecording);
      delete process.env.AWS_S3_BUCKET_NAME;

      await deleteRecording(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'S3 bucket name not configured on server.' });
    });
  });

});
