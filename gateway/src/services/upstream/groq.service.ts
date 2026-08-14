import { env } from '../../config/env';
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  LLMProvider,
  UPSTREAM_TIMEOUT_MS,
} from '../../types/provider.types';

interface GroqChoice {
  message?: {
    content?: string;
  };
}

interface GroqResponse {
  model?: string;
  choices?: GroqChoice[];
  usage?: {
    total_tokens?: number;
  };
}

class GroqProvider implements LLMProvider {
  async complete(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    if (!env.GROQ_API_KEY) {
      throw new Error('GROQ_API_KEY is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      const upstreamRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: req.model,
          messages: [{ role: 'user', content: req.prompt }],
        }),
        signal: controller.signal,
      });

      if (!upstreamRes.ok) {
        const errorBody = await upstreamRes.text();
        throw new Error(`Groq upstream error (${upstreamRes.status}): ${errorBody}`);
      }

      const payload = (await upstreamRes.json()) as GroqResponse;
      const content = payload.choices?.[0]?.message?.content?.trim();

      if (!content) {
        throw new Error('Groq upstream returned an empty completion');
      }

      return {
        response: content,
        model: payload.model ?? req.model,
        provider: 'groq',
        tokensUsed: payload.usage?.total_tokens,
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Groq request timed out after ${UPSTREAM_TIMEOUT_MS}ms`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const groqProvider = new GroqProvider();

export async function completeWithGroq(
  req: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  return groqProvider.complete(req);
}
