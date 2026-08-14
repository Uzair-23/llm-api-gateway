import { Router } from 'express';
import { createChatCompletion } from '../controllers/chat.controller';
import { auth } from '../middleware/auth.middleware';
import { rateLimiter } from '../middleware/rateLimiter.middleware';
import { cache } from '../middleware/cache.middleware';

const router = Router();

// Circuit breaker is intentionally NOT mounted as a single route middleware.
// This endpoint uses two providers (Groq primary, Gemini fallback), each with
// independent circuit CHECK/REPORT operations performed inside callWithFallback.
router.post('/v1/chat/completions', auth, rateLimiter(100, 60), cache, createChatCompletion);

export default router;
