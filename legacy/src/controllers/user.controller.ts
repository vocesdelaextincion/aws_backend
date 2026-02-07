import { Request, Response, NextFunction } from 'express';

export const getMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  // The user object is attached by the 'protect' middleware.
  // We are using 'as any' for now, consistent with the middleware implementation.
  const user = (req as any).user;

  // This case should ideally not be hit if the 'protect' middleware is always used before this controller.
  if (!user) {
    res.status(401).json({ message: 'Not authorized' });
    return;
  }

  res.status(200).json(user);
};
