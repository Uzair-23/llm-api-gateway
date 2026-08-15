import { Request, Response, NextFunction } from 'express';
import { getQueue } from '../config/queue';
import { getRedis } from '../config/redis';
import { jobResultKey } from '../utils/keys';
import { NotFoundError } from '../utils/errors';

/**
 * GET /v1/jobs/:jobId
 * Poll the status of an enqueued async request.
 */
export async function getJobStatus(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const jobId = String(req.params.jobId);
    const queue = getQueue();
    const job = await queue.getJob(jobId);

    if (!job) {
      throw new NotFoundError('Job not found');
    }

    const status = await job.getState();

    if (status === 'completed') {
      const redis = getRedis();
      const resultRaw = await redis.get(jobResultKey(jobId));
      let result: unknown = null;
      if (resultRaw) {
        try {
          result = JSON.parse(resultRaw);
        } catch (_e) {
          result = resultRaw;
        }
      }
      res.status(200).json({ jobId, status, result });
      return;
    }

    if (status === 'failed') {
      res.status(200).json({
        jobId,
        status,
        error: job.failedReason || 'Job failed',
      });
      return;
    }

    res.status(200).json({ jobId, status });
  } catch (err) {
    next(err);
  }
}
