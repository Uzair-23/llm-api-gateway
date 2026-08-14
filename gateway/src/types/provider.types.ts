export type ProviderName = 'groq' | 'gemini';

export interface ChatCompletionRequest {
  prompt: string;
  model: string;
}

export interface ChatCompletionResponse {
  response: string;
  model: string;
  provider: ProviderName;
  tokensUsed?: number;
}

export interface LLMProvider {
  complete(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
}

export const UPSTREAM_TIMEOUT_MS = 10_000;
