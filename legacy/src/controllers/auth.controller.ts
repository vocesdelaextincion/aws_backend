import { Request, Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { generateToken } from '../utils/jwt';
import sendEmail from '../utils/email';

export const register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email, password } = req.body;

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      res.status(409).json({ message: 'User with this email already exists' });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const emailVerificationTokenExpires = new Date(Date.now() + 3600000); // 1 hour from now

    const newUser = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        emailVerificationToken: verificationToken,
        emailVerificationTokenExpires: emailVerificationTokenExpires,
      },
    });

    // Send verification email
    const verificationUrl = `http://localhost:${process.env.PORT || 3000}/api/auth/verify-email/${verificationToken}`;
    const emailSubject = 'Welcome to Voces de la Extinción! Please Verify Your Email';
    const emailText = `Thank you for registering. Please verify your email by clicking this link: ${verificationUrl}`;
    const emailHtml = `<p>Thank you for registering. Please verify your email by clicking this link: <a href="${verificationUrl}">${verificationUrl}</a></p>`;

    try {
      await sendEmail({
        to: newUser.email,
        subject: emailSubject,
        text: emailText,
        html: emailHtml,
      });
    } catch (error) {
      // If email fails, we might want to log it but not fail the registration.
      // The user can request a new verification email later.
      console.error('Failed to send verification email:', error);
    }

    res.status(201).json({ 
      message: 'User created successfully. Please verify your email.',
      user: {
        id: newUser.id,
        email: newUser.email,
        plan: newUser.plan,
        role: newUser.role
      }
    });
  } catch (error) {
    next(error);
  }
};

export const verifyEmail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { token } = req.params;

    if (!token) {
      res.status(400).json({ message: 'Verification token is required.' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { emailVerificationToken: token },
    });

    if (!user) {
      res.status(404).json({ message: 'Invalid verification token.' });
      return;
    }

    if (user.emailVerificationTokenExpires && user.emailVerificationTokenExpires < new Date()) {
      // Optionally, you could allow resending the verification email here
      res.status(410).json({ message: 'Verification token has expired.' });
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        isVerified: true,
        emailVerificationToken: null,
        emailVerificationTokenExpires: null,
      },
    });

    res.status(200).json({ message: 'Email verified successfully. You can now log in.' });
  } catch (error) {
    next(error);
  }
};

export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      res.status(401).json({ message: 'Invalid credentials' });
      return;
    }

    const isPasswordMatch = await bcrypt.compare(password, user.password);

    if (!isPasswordMatch) {
      res.status(401).json({ message: 'Invalid credentials' });
      return;
    }

    if (!user.isVerified) {
      res.status(403).json({ message: 'Please verify your email before logging in.' });
      return;
    }

    const token = generateToken({ id: user.id, role: user.role });

    res.status(200).json({ 
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan,
        role: user.role
      }
    });

  } catch (error) {
    next(error);
  }
};

export const forgotPassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email } = req.body;

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      // To prevent email enumeration, we send a success response even if the user doesn't exist.
      res.status(200).json({ message: 'If a user with that email exists, a password reset link has been sent.' });
      return;
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const passwordResetTokenExpires = new Date(Date.now() + 3600000); // 1 hour from now

    await prisma.user.update({
      where: { email },
      data: {
        passwordResetToken: resetToken,
        passwordResetTokenExpires: passwordResetTokenExpires,
      },
    });

    // Send password reset email
    const resetUrl = `http://localhost:${process.env.PORT || 3000}/api/auth/reset-password/${resetToken}`; // In a real app, this would be a frontend URL
    const emailSubject = 'Your Password Reset Request';
    const emailText = `You requested a password reset. Please use the following link to reset your password: ${resetUrl}`;
    const emailHtml = `<p>You requested a password reset. Please use the following link to reset your password: <a href="${resetUrl}">${resetUrl}</a></p>`;

    try {
      await sendEmail({
        to: user.email,
        subject: emailSubject,
        text: emailText,
        html: emailHtml,
      });
    } catch (error) {
      // Log the error, but don't reveal to the user that the email failed to send.
      // This prevents leaking information about which emails are registered.
      console.error('Failed to send password reset email:', error);
    }

    res.status(200).json({ message: 'If a user with that email exists, a password reset link has been sent.' });
  } catch (error) {
    next(error);
  }
};

export const resetPassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: token,
        passwordResetTokenExpires: { gt: new Date() },
      },
    });

    if (!user) {
      res.status(400).json({ message: 'Invalid or expired password reset token.' });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        passwordResetToken: null,
        passwordResetTokenExpires: null,
      },
    });

    res.status(200).json({ message: 'Password has been reset successfully.' });
  } catch (error) {
    next(error);
  }
};

export const me = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // The protect middleware already validates the token and attaches the user to req
    const user = (req as any).user;
    
    if (!user) {
      res.status(401).json({ message: 'Not authorized' });
      return;
    }

    // Return user information (excluding sensitive data)
    res.status(200).json({
      id: user.id,
      email: user.email,
      plan: user.plan,
      role: user.role,
      isVerified: user.isVerified
    });
  } catch (error) {
    next(error);
  }
};
