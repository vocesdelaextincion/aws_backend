import { Request, Response, NextFunction } from 'express';
import {
  getTags,
  getTagById,
  createTag,
  updateTag,
  deleteTag,
} from '../../src/controllers/tag.controller';
import prisma from '../../src/config/prisma';

// Mock dependencies
jest.mock('../../src/config/prisma', () => ({
  tag: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
}));

describe('Tag Controller', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    req = {
      params: {},
      body: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      send: jest.fn(),
    };
    next = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getTags', () => {
    it('should fetch all tags and return them', async () => {
      const tags = [{ id: '1', name: 'Test Tag' }];
      (prisma.tag.findMany as jest.Mock).mockResolvedValue(tags);

      await getTags(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(tags);
    });
  });

  describe('getTagById', () => {
    it('should fetch a single tag by id', async () => {
      const tag = { id: '1', name: 'Test Tag' };
      req.params = { id: '1' };
      (prisma.tag.findUnique as jest.Mock).mockResolvedValue(tag);

      await getTagById(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(tag);
    });

    it('should return 404 if tag not found', async () => {
      req.params = { id: '1' };
      (prisma.tag.findUnique as jest.Mock).mockResolvedValue(null);

      await getTagById(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ message: 'Tag not found' });
    });
  });

  describe('createTag', () => {
    it('should create a new tag and return it', async () => {
      const newTag = { id: '1', name: 'New Tag' };
      req.body = { name: 'New Tag' };
      (prisma.tag.create as jest.Mock).mockResolvedValue(newTag);

      await createTag(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(newTag);
    });
  });

  describe('updateTag', () => {
    it('should update a tag and return it', async () => {
      const updatedTag = { id: '1', name: 'Updated Tag' };
      req.params = { id: '1' };
      req.body = { name: 'Updated Tag' };
      (prisma.tag.update as jest.Mock).mockResolvedValue(updatedTag);

      await updateTag(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(updatedTag);
    });
  });

  describe('deleteTag', () => {
    it('should delete a tag and return 204', async () => {
      req.params = { id: '1' };
      (prisma.tag.delete as jest.Mock).mockResolvedValue({});

      await deleteTag(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });
  });
});
