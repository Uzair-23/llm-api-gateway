import { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { UsageLog } from '../models/UsageLog.model';
import { Tenant } from '../models/Tenant.model';
import { getRedis, isRedisAvailable } from '../config/redis';
import { rateLimitKey } from '../utils/keys';
import { env } from '../config/env';
import { UnauthorizedError, NotFoundError } from '../utils/errors';

export async function getDashboardUsage(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tenantIdStr = req.tenant?.tenantId;
    if (!tenantIdStr) {
      throw new UnauthorizedError('Authentication required');
    }

    const tenantId = new Types.ObjectId(tenantIdStr);
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // 1. Aggregation for overall summary stats in 24h sliding window
    const summaryResult = await UsageLog.aggregate([
      {
        $match: {
          tenantId,
          timestamp: { $gte: twentyFourHoursAgo },
        },
      },
      {
        $group: {
          _id: null,
          totalRequests: { $sum: 1 },
          cacheHits: {
            $sum: { $cond: [{ $eq: ['$cacheHit', true] }, 1, 0] },
          },
          totalLatency: { $sum: '$latencyMs' },
          groqCalls: {
            $sum: { $cond: [{ $eq: ['$provider', 'groq'] }, 1, 0] },
          },
          geminiCalls: {
            $sum: { $cond: [{ $eq: ['$provider', 'gemini'] }, 1, 0] },
          },
        },
      },
    ]);

    let totalRequests = 0;
    let cacheHits = 0;
    let cacheHitRate = 0;
    let averageLatencyMs = 0;
    let groqCalls = 0;
    let geminiCalls = 0;

    if (summaryResult.length > 0) {
      const summary = summaryResult[0];
      totalRequests = summary.totalRequests || 0;
      cacheHits = summary.cacheHits || 0;
      const totalLatency = summary.totalLatency || 0;
      groqCalls = summary.groqCalls || 0;
      geminiCalls = summary.geminiCalls || 0;

      if (totalRequests > 0) {
        cacheHitRate = Math.round((cacheHits / totalRequests) * 1000) / 10;
        averageLatencyMs = Math.round(totalLatency / totalRequests);
      }
    }

    // 2. Aggregation for time-series breakdown (hourly slots in UTC/local format)
    const timeSeriesResult = await UsageLog.aggregate([
      {
        $match: {
          tenantId,
          timestamp: { $gte: twentyFourHoursAgo },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$timestamp' },
            month: { $month: '$timestamp' },
            day: { $dayOfMonth: '$timestamp' },
            hour: { $hour: '$timestamp' },
          },
          firstTs: { $min: '$timestamp' },
          requests: { $sum: 1 },
          cacheHits: {
            $sum: { $cond: [{ $eq: ['$cacheHit', true] }, 1, 0] },
          },
        },
      },
      { $sort: { firstTs: 1 } },
    ]);

    const requestsOverTime = timeSeriesResult.map((item) => {
      const hourNum = item._id.hour;
      const timeStr = `${String(hourNum).padStart(2, '0')}:00`;
      return {
        time: timeStr,
        requests: item.requests,
        cacheHits: item.cacheHits,
      };
    });

    const providerDistribution = [
      { name: 'Groq (Primary)', value: groqCalls },
      { name: 'Gemini (Fallback)', value: geminiCalls },
    ];

    res.status(200).json({
      totalRequests,
      cacheHitRate,
      averageLatencyMs,
      requestsOverTime,
      providerDistribution,
    });
  } catch (err) {
    next(err);
  }
}

export async function getDashboardLimits(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tenantIdStr = req.tenant?.tenantId;
    if (!tenantIdStr) {
      throw new UnauthorizedError('Authentication required');
    }

    const tenant = await Tenant.findById(tenantIdStr);
    if (!tenant) {
      throw new NotFoundError('Tenant not found');
    }

    let currentUsage = 0;
    if (isRedisAvailable()) {
      const redis = getRedis();
      const key = rateLimitKey(tenantIdStr);
      const now = Date.now();
      const windowMs = (env.RATE_LIMIT_WINDOW_SECONDS || 60) * 1000;
      await redis.zremrangebyscore(key, '-inf', now - windowMs);
      currentUsage = await redis.zcard(key);
    }

    res.status(200).json({
      planTier: tenant.planTier,
      rateLimitPerMin: tenant.rateLimitPerMin,
      currentUsage,
      resetAt: new Date(Date.now() + 60 * 1000).toISOString(),
    });
  } catch (err) {
    next(err);
  }
}
