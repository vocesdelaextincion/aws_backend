import { Router } from 'express';
import {
  getTags,
  getTagById,
  createTag,
  updateTag,
  deleteTag,
} from '../controllers/tag.controller';
import { protect, admin } from '../middleware/auth.middleware';
import { createTagValidator, updateTagValidator, handleValidationErrors } from '../middleware/validators';

const router = Router();

// All routes in this file are protected and only accessible by admins
router.use(protect, admin);

router.route('/')
  .get(getTags)
  .post(createTagValidator, handleValidationErrors, createTag);

router.route('/:id')
  .get(getTagById)
  .put(updateTagValidator, handleValidationErrors, updateTag)
  .delete(deleteTag);

export default router;
