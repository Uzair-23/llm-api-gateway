import { Router } from 'express';
import { getDashboardUsage, getDashboardLimits } from '../controllers/dashboard.controller';
import { jwtAuth } from '../middleware/jwtAuth.middleware';

const router = Router();

router.get('/dashboard/usage', jwtAuth, getDashboardUsage);
router.get('/dashboard/limits', jwtAuth, getDashboardLimits);

export default router;
