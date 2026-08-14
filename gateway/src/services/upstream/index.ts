import { isRedisAvailable } from '../../config/redis';
import { ServiceUnavailableError } from '../../utils/errors';
import {
  reportCircuitFailure,
  reportCircuitSuccess,
  runCircuitAction,
} from '../../utils/reportCircuitResult.util';
import { ChatCompletionRequest, ChatCompletionResponse, ProviderName } from '../../types/provider.types';
import { completeWithGemini } from './gemini.service';
import { completeWithGroq } from './groq.service';

interface ProviderAttempt {
  provider: ProviderName;
  invoke: (req: ChatCompletionRequest) => Promise<ChatCompletionResponse>;
}

async function isProviderAllowed(provider: ProviderName): Promise<boolean> {
  if (!isRedisAvailable()) {
    return true;
  }

  try {
    const decision = await runCircuitAction(provider, 'CHECK');
    return decision === 'ALLOW';
  } catch (err) {
    // Fail-open: if Redis/circuit-check is degraded, still try the provider.
    console.error(
      '[CIRCUIT-DEGRADED] Failed to check provider circuit, allowing request:',
      err instanceof Error ? err.message : err,
    );
    return true;
  }
}

async function reportSuccess(provider: ProviderName): Promise<void> {
  try {
    await reportCircuitSuccess(provider);
  } catch (err) {
    console.error(
      '[CIRCUIT-DEGRADED] Failed to report circuit success:',
      err instanceof Error ? err.message : err,
    );
  }
}

async function reportFailure(provider: ProviderName): Promise<void> {
  try {
    await reportCircuitFailure(provider);
  } catch (err) {
    console.error(
      '[CIRCUIT-DEGRADED] Failed to report circuit failure:',
      err instanceof Error ? err.message : err,
    );
  }
}

export async function callWithFallback(
  req: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const providers: ProviderAttempt[] = [
    { provider: 'groq', invoke: completeWithGroq },
    { provider: 'gemini', invoke: completeWithGemini },
  ];

  let attempted = 0;
  const failureReasons: string[] = [];

  // Resilience strategy: try provider diversity in order. Each provider has
  // an independent circuit, so one outage does not take down all traffic.
  for (const candidate of providers) {
    const allowed = await isProviderAllowed(candidate.provider);
    if (!allowed) {
      failureReasons.push(`${candidate.provider}:circuit-open`);
      continue;
    }

    attempted += 1;

    try {
      const result = await candidate.invoke(req);
      await reportSuccess(candidate.provider);
      return result;
    } catch (err) {
      await reportFailure(candidate.provider);
      const reason = err instanceof Error ? err.message : String(err);
      failureReasons.push(`${candidate.provider}:${reason}`);
    }
  }

  const message = `AllProvidersUnavailable: attempted=${attempted}; reasons=${failureReasons.join(' | ')}`;
  throw new ServiceUnavailableError(message);
}
