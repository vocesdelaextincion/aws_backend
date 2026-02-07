import { Request, Response, NextFunction } from "express";
import prisma from "../config/prisma";

export const getMetrics = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const [totalUsers, totalAdmins, totalRecordings, totalTags] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { role: 'ADMIN' } }),
      prisma.recording.count(),
      prisma.tag.count(),
    ]);

    res.json({
      totalUsers,
      totalAdmins,
      totalRecordings,
      totalTags,
    });
  } catch (error) {
    next(error);
  }
};
