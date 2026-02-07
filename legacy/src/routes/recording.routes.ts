import { Router } from 'express';
import multer from 'multer';
import {
  getRecordings,
  getRecordingById,
  createRecording,
  updateRecording,
  deleteRecording,
} from '../controllers/recording.controller';
import { protect, admin } from '../middleware/auth.middleware';
import {
  createRecordingValidator,
  updateRecordingValidator,
  handleValidationErrors,
} from '../middleware/validators';

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage });

const router = Router();

// All routes in this file are protected
router.use(protect);

router.route('/')
  .get(getRecordings)
  .post(admin, upload.single("recording"), createRecordingValidator, handleValidationErrors, createRecording);

router.route('/:id')
  .get(getRecordingById)
  .put(admin, upload.single("recording"), updateRecordingValidator, handleValidationErrors, updateRecording)
  .delete(admin, deleteRecording);

export default router;
