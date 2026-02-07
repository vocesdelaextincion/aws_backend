import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { extname } from "path";
import prisma from "../config/prisma";
import { deleteS3Object, uploadToS3 } from "../utils/s3";

/**
 * Get recordings with pagination and search functionality
 *
 * Query Parameters:
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 10, max: 100)
 * - search: Search term(s) to filter across title, description, and tags
 *   Can be a single term or multiple comma-separated terms
 *
 * Example usage:
 * GET /recordings?page=2&limit=20&search=nature
 * GET /recordings?search=bird sounds
 * GET /recordings?search=nature,birds,animal
 * GET /recordings?page=1&limit=5
 */
export const getRecordings = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Parse pagination parameters
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit as string) || 10)
    );
    const skip = (page - 1) * limit;

    // Parse search parameter
    const search = req.query.search as string;

    // Build where clause for search
    let whereClause = {};

    if (search) {
      // Split search terms by comma and trim whitespace
      const searchTerms = search
        .split(",")
        .map((term) => term.trim())
        .filter((term) => term.length > 0);

      if (searchTerms.length > 0) {
        // Create OR conditions for each search term across all fields
        const searchConditions = searchTerms.map((term) => ({
          OR: [
            {
              title: {
                contains: term,
                mode: "insensitive" as const,
              },
            },
            {
              description: {
                contains: term,
                mode: "insensitive" as const,
              },
            },
            {
              tags: {
                some: {
                  name: {
                    contains: term,
                    mode: "insensitive" as const,
                  },
                },
              },
            },
          ],
        }));

        // Use OR to match any of the search terms
        whereClause = {
          OR: searchConditions,
        };
      }
    }

    // Get total count for pagination metadata
    const totalCount = await prisma.recording.count({
      where: whereClause,
    });

    // Get recordings with pagination and search
    const recordings = await prisma.recording.findMany({
      where: whereClause,
      include: {
        tags: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      skip,
      take: limit,
    });

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    res.status(200).json({
      data: recordings,
      pagination: {
        currentPage: page,
        totalPages,
        totalCount,
        limit,
        hasNextPage,
        hasPreviousPage,
      },
      search: search || null,
    });
  } catch (error) {
    next(error);
  }
};

export const getRecordingById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    const recording = await prisma.recording.findUnique({
      where: {
        id,
      },
      include: {
        tags: true,
      },
    });

    if (!recording) {
      res.status(404).json({ message: "Recording not found" });
      return;
    }

    res.status(200).json(recording);
  } catch (error) {
    next(error);
  }
};

export const createRecording = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { title, description, tags, metadata } = req.body;
    const file = req.file;

    if (!title || !file) {
      res.status(400).json({ message: "Title and file are required." });
      return;
    }

    const bucketName = process.env.AWS_S3_BUCKET_NAME;
    if (!bucketName) {
      res
        .status(500)
        .json({ message: "S3 bucket name not configured on server." });
      return;
    }

    const fileExtension = extname(file.originalname);
    const fileKey = `${randomUUID()}${fileExtension}`;
    const { fileUrl } = await uploadToS3(bucketName, fileKey, file.buffer);

    const tagConnections =
      tags && Array.isArray(tags)
        ? tags.map((tagId: string) => ({
            id: tagId,
          }))
        : [];

    // Metadata is expected to be a stringified JSON from the frontend
    const parsedMetadata = metadata ? JSON.parse(metadata) : undefined;

    const newRecording = await prisma.recording.create({
      data: {
        title,
        description,
        fileUrl,
        fileKey,
        metadata: parsedMetadata,
        tags: {
          connect: tagConnections,
        },
      },
      include: {
        tags: true,
      },
    });

    res.status(201).json(newRecording);
  } catch (error) {
    next(error);
  }
};

export const updateRecording = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const { title, description, tags, metadata } = req.body;
    const file = req.file;

    const recording = await prisma.recording.findUnique({
      where: { id },
    });

    if (!recording) {
      res.status(404).json({ message: "Recording not found" });
      return;
    }

    let fileUrl = recording.fileUrl;
    let fileKey = recording.fileKey;

    if (file) {
      const bucketName = process.env.AWS_S3_BUCKET_NAME;
      if (!bucketName) {
        res
          .status(500)
          .json({ message: "S3 bucket name not configured on server." });
        return;
      }

      if (recording.fileKey) {
        await deleteS3Object(bucketName, recording.fileKey);
      }

      const fileExtension = extname(file.originalname);
      const newFileKey = `${randomUUID()}${fileExtension}`;
      const uploadResult = await uploadToS3(
        bucketName,
        newFileKey,
        file.buffer
      );
      fileUrl = uploadResult.fileUrl;
      fileKey = uploadResult.fileKey;
    }

    const tagConnections =
      tags && Array.isArray(tags)
        ? tags.map((tagId: string) => ({
            id: tagId,
          }))
        : [];

    // Metadata is expected to be a stringified JSON from the frontend
    const parsedMetadata = metadata ? JSON.parse(metadata) : undefined;

    const updatedRecording = await prisma.recording.update({
      where: { id },
      data: {
        title,
        description,
        fileUrl,
        fileKey,
        metadata: parsedMetadata,
        tags: {
          set: tagConnections,
        },
      },
      include: {
        tags: true,
      },
    });

    res.status(200).json(updatedRecording);
  } catch (error) {
    next(error);
  }
};

export const deleteRecording = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    const recording = await prisma.recording.findUnique({
      where: { id },
    });

    if (!recording) {
      res.status(404).json({ message: "Recording not found" });
      return;
    }

    const bucketName = process.env.AWS_S3_BUCKET_NAME;
    if (!bucketName) {
      res
        .status(500)
        .json({ message: "S3 bucket name not configured on server." });
      return;
    }

    // Delete the object from S3 first
    await deleteS3Object(bucketName, recording.fileKey);

    // Then delete the recording from the database
    await prisma.recording.delete({
      where: { id },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
