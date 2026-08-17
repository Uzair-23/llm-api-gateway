import { Request, Response, NextFunction } from 'express';
import { UsageLog } from '../models/UsageLog.model';

/**
 * Async non-blocking usage logger middleware (Architectural Rule #7).
 *
 * Attaches a `res.on('finish')` listener that asynchronously records a UsageLog
 * after the HTTP response has been sent to the client.
 * Does NOT await the write, so Mongo latency never impacts client response times.
 */
export function usageLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  // Intercept res.json to capture completion metrics (cacheHit, provider, tokensUsed)
  const originalJson = res.json.bind(res);
  res.json = function (body: unknown): Response {
    if (body && typeof body === 'object') {
      const b = body as Record<string, unknown>;
      if (b.cacheHit !== undefined) {
        res.locals.cacheHit = Boolean(b.cacheHit);
      }
      if (b.provider) {
        res.locals.provider = String(b.provider);
      }
      if (b.tokensUsed !== undefined) {
        res.locals.tokensUsed = Number(b.tokensUsed);
      } else if (b.usage && typeof b.usage === 'object') {
        const usage = b.usage as Record<string, unknown>;
        if (usage.total_tokens !== undefined) {
          res.locals.tokensUsed = Number(usage.total_tokens);
        }
      }
    }
    return originalJson(body as never);
  } as typeof res.json;

  res.on('finish', () => {
    const tenantId = req.tenant?.tenantId;
    if (!tenantId) return;

    const latencyMs = Date.now() - startTime;
    const statusCode = res.statusCode;
    const cacheHit = Boolean(res.locals.cacheHit);
    const rawProvider = res.locals.provider as string | undefined;
    const provider = cacheHit ? null : (rawProvider === 'groq' || rawProvider === 'gemini' ? rawProvider : null);
    const tokensUsed = Number(res.locals.tokensUsed ?? 0);
    const endpoint = req.baseUrl ? `${req.baseUrl}${req.path}` : (req.path || '/v1/chat/completions');

    UsageLog.create({
      tenantId,
      timestamp: new Date(),
      endpoint,
      provider,
      cacheHit,
      tokensUsed,
      latencyMs,
      statusCode,
    }).catch((err) => {
      console.warn('UsageLog write failed:', err);
    });
  });

  next();
}
