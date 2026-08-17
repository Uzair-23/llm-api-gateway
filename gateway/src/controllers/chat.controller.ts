import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { callWithFallback } from '../services/upstream';
import { getQueue } from '../config/queue';

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

    if (req.query.async === 'true') {
      const queue = getQueue();
      const job = await queue.add('chat-completion', {
        prompt: parsed.prompt,
        model: parsed.model,
        tenantId: req.tenant?.tenantId,
      });

      res.status(202).json({ jobId: job.id });
      return;
    }

    const completion = await callWithFallback(parsed);

    res.status(200).json(completion);
  } catch (err) {
    next(err);
  }
}
