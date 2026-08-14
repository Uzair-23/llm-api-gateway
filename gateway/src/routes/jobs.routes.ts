import { Router } from 'express';
import { getJobStatus } from '../controllers/jobs.controller';
import { auth } from '../middleware/auth.middleware';

const router = Router();

// TODO: Job visibility is currently not restricted to the owning tenant
// (job->tenant ownership check is skipped for portfolio simplicity, not
// production-ready multi-tenant isolation of job visibility).
router.get('/v1/jobs/:jobId', auth, getJobStatus);

export default router;
