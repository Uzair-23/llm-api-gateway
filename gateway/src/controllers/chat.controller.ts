import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { callWithFallback } from '../services/upstream';

const chatCompletionBodySchema = z.object({
  prompt: z.string().min(1, 'prompt is required'),
  model: z.string().min(1, 'model is required'),
});

export async function createChatCompletion(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = chatCompletionBodySchema.parse(req.body);
    const completion = await callWithFallback(parsed);

    res.status(200).json(completion);

    // TODO(Phase 7+): Write UsageLog asynchronously after response completes.
    // The UsageLog schema/worker flow from PRD Section 4 is intentionally
    // deferred; do not block the response path on logging in Phase 6.
    setImmediate(() => {
      // Placeholder for non-blocking UsageLog.create(...) in a later phase.
    });
  } catch (err) {
    next(err);
  }
}
