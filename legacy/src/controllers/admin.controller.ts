import { Request, Response, NextFunction } from "express";
import prisma from "../config/prisma";

/**
 * Get users with pagination and search functionality
 * 
 * Query Parameters:
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 10, max: 100)
 * - search: Search term(s) to filter across email
 *   Can be a single term or multiple comma-separated terms
 * 
 * Example usage:
 * GET /users?page=2&limit=20&search=john
 * GET /users?search=admin@example.com
 * GET /users?search=john,admin
 * GET /users?page=1&limit=5
 */
export const getUsers = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Parse pagination parameters
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 10));
    const skip = (page - 1) * limit;
    
    // Parse search parameter
    const search = req.query.search as string;
    
    // Build where clause for search
    let whereClause = {};
    
    if (search) {
      // Split search terms by comma and trim whitespace
      const searchTerms = search.split(',').map(term => term.trim()).filter(term => term.length > 0);
      
      if (searchTerms.length > 0) {
        // Create OR conditions for each search term across email field
        const searchConditions = searchTerms.map(term => ({
          OR: [
            {
              email: {
                contains: term,
                mode: 'insensitive' as const,
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
    const totalCount = await prisma.user.count({
      where: whereClause,
    });

    // Get users with pagination and search
    const users = await prisma.user.findMany({
      where: whereClause,
      select: {
        id: true,
        email: true,
        isVerified: true,
        plan: true,
        role: true,
        createdAt: true,
        updatedAt: true,
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
      data: users,
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

export const getUserById = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { id } = req.params;
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        isVerified: true,
        plan: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ message: "User not found" });
    } else {
      res.json(user);
    }
  } catch (error) {
    next(error);
  }
};

export const updateUser = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { id } = req.params;
    const { email, isVerified, plan, role } = req.body;

    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        email,
        isVerified,
        plan,
        role,
      },
      select: {
        id: true,
        email: true,
        isVerified: true,
        plan: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json(updatedUser);
  } catch (error) {
    next(error);
  }
};

export const deleteUser = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { id } = req.params;
    await prisma.user.delete({
      where: { id },
    });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
