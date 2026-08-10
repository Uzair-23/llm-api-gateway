import { Router } from 'express';
import { signup, login, rotateApiKey } from '../controllers/auth.controller';
import { jwtAuth } from '../middleware/jwtAuth.middleware';

const router = Router();

router.post('/signup', signup);
router.post('/login', login);
// JWT-protected — only the authenticated tenant can rotate their own key.
router.post('/api-key/rotate', jwtAuth, rotateApiKey);

export default router;
