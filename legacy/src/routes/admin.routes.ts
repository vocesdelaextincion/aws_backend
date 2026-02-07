import { Router } from 'express';
import {
  getUsers,
  getUserById,
  updateUser,
  deleteUser
} from '../controllers/admin.controller';
import { protect, admin } from '../middleware/auth.middleware';

const router = Router();

// Protect all admin routes
router.use(protect, admin);

// User Management
router.get('/users', getUsers);
router.get('/users/:id', getUserById);
router.put('/users/:id', updateUser);
router.delete('/users/:id', deleteUser);

export default router;
