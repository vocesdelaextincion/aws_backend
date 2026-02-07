import { Request, Response, NextFunction } from "express";
import prisma from "../config/prisma";

/**
 * Get tags with search functionality
 *
 * Query Parameters:
 * - search: Search term(s) to filter across tag name
 *   Can be a single term or multiple comma-separated terms
 *
 * Example usage:
 * GET /tags?search=nature
 * GET /tags?search=bird sounds
 * GET /tags?search=nature,birds,animal
 */
export const getTags = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
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
        // Create OR conditions for each search term across name field
        const searchConditions = searchTerms.map((term) => ({
          OR: [
            {
              name: {
                contains: term,
                mode: "insensitive" as const,
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

    // Get tags with search
    const tags = await prisma.tag.findMany({
      where: whereClause,
      orderBy: {
        name: "asc",
      },
    });

    res.status(200).json({
      data: tags,
      search: search || null,
    });
  } catch (error) {
    next(error);
  }
};

export const getTagById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const tag = await prisma.tag.findUnique({
      where: { id },
    });

    if (!tag) {
      res.status(404).json({ message: "Tag not found" });
      return;
    }

    res.status(200).json(tag);
  } catch (error) {
    next(error);
  }
};

export const createTag = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { name } = req.body;

    const newTag = await prisma.tag.create({
      data: {
        name,
      },
    });

    res.status(201).json(newTag);
  } catch (error) {
    next(error);
  }
};

export const updateTag = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    const updatedTag = await prisma.tag.update({
      where: { id },
      data: {
        name,
      },
    });

    res.status(200).json(updatedTag);
  } catch (error) {
    next(error);
  }
};

export const deleteTag = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    await prisma.tag.delete({
      where: { id },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
