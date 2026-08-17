import { env } from '../../config/env';
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  LLMProvider,
  UPSTREAM_TIMEOUT_MS,
} from '../../types/provider.types';

interface GeminiPart {
  text?: string;
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiPart[];
  };
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    totalTokenCount?: number;
  };
}

function resolveGeminiModel(model: string): string {
  const normalized = model.trim();
  if (!normalized) {
    return 'gemini-2.5-flash';
  }

  const lowered = normalized.toLowerCase();
  if (lowered.includes('gemini')) {
    return normalized;
  }

  // Groq and Gemini use different model families. If a Groq model string is
  // passed into the Gemini fallback, translate it to a valid Gemini model
  // rather than failing with a 404 from Google.
  return 'gemini-2.5-flash';
}

class GeminiProvider implements LLMProvider {
  async complete(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    if (!env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      const modelName = resolveGeminiModel(req.model);
      const model = encodeURIComponent(modelName);
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

      const upstreamRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: req.prompt }],
            },
          ],
        }),
        signal: controller.signal,
      });

      if (!upstreamRes.ok) {
        const errorBody = await upstreamRes.text();
        throw new Error(`Gemini upstream error (${upstreamRes.status}): ${errorBody}`);
      }

      const payload = (await upstreamRes.json()) as GeminiResponse;
      const content = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim();

      if (!content) {
        throw new Error('Gemini upstream returned an empty completion');
      }

      return {
        response: content,
        model: modelName,
        provider: 'gemini',
        tokensUsed: payload.usageMetadata?.totalTokenCount,
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Gemini request timed out after ${UPSTREAM_TIMEOUT_MS}ms`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const geminiProvider = new GeminiProvider();

export async function completeWithGemini(
  req: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  return geminiProvider.complete(req);
}
