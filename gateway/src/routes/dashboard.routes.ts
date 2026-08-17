import { Router } from 'express';
import { getDashboardUsage, getDashboardLimits } from '../controllers/dashboard.controller';
import { createChatCompletion } from '../controllers/chat.controller';
import { jwtAuth } from '../middleware/jwtAuth.middleware';
import { usageLogger } from '../middleware/usageLogger.middleware';
import { rateLimiter } from '../middleware/rateLimiter.middleware';
import { cache } from '../middleware/cache.middleware';

const router = Router();

router.get('/dashboard/usage', jwtAuth, getDashboardUsage);
router.get('/dashboard/limits', jwtAuth, getDashboardLimits);
router.post('/dashboard/playground', jwtAuth, usageLogger, rateLimiter(100, 60), cache, createChatCompletion);

export default router;
