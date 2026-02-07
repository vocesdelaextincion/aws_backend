import * as jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";

export const generateToken = (payload: object): string => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error("JWT secret is not set in environment variables.");
  }

  const options: SignOptions = {
    expiresIn: "7d", // Set expiration to 7 days for development
  };

  return jwt.sign(payload, secret, options);
};
