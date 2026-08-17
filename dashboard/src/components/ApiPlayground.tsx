import React, { useState } from 'react';
import { sendPlaygroundChat } from '../services/api.service';
import type { PlaygroundResponse } from '../types/api.types';

interface ApiPlaygroundProps {
  onRequestComplete?: () => void;
}

interface PlaygroundResult {
  statusCode: number;
  latencyMs: number;
  response?: string;
  model?: string;
  provider?: string;
  tokensUsed?: number;
  cacheHit?: boolean;
  error?: string;
}

export const ApiPlayground: React.FC<ApiPlaygroundProps> = ({ onRequestComplete }) => {
  const [prompt, setPrompt] = useState<string>('Explain API Gateway caching in 10 words');
  const [model, setModel] = useState<string>('llama-3.1-8b-instant');
  const [loading, setLoading] = useState<boolean>(false);
  const [result, setResult] = useState<PlaygroundResult | null>(null);

  const handleSendRequest = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!prompt.trim() || loading) return;

    setLoading(true);
    setResult(null);
    const start = Date.now();

    try {
      const data: PlaygroundResponse = await sendPlaygroundChat(prompt.trim(), model);
      const latencyMs = Date.now() - start;
      setResult({
        statusCode: 200,
        latencyMs,
        response: data.response,
        model: data.model,
        provider: data.provider,
        tokensUsed: data.tokensUsed,
        cacheHit: data.cacheHit,
      });
    } catch (err: unknown) {
      const latencyMs = Date.now() - start;
      let status = 500;
      let errorMsg = 'Request failed';

      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { status?: number; data?: { error?: string } } };
        status = axiosErr.response?.status || 500;
        errorMsg = axiosErr.response?.data?.error || 'Request failed';
      } else if (err instanceof Error) {
        errorMsg = err.message;
      }

      setResult({
        statusCode: status,
        latencyMs,
        error: errorMsg,
      });
    } finally {
      setLoading(false);
      if (onRequestComplete) {
        onRequestComplete();
      }
    }
  };

  return (
    <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 backdrop-blur-xl space-y-6 shadow-xl">
      {/* Panel Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/80 pb-4">
        <div>
          <div className="flex items-center space-x-2">
            <h2 className="text-lg font-bold text-white tracking-tight">API Playground</h2>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30 uppercase">
              Single-Shot Test
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Test gateway execution live — observe real-time provider routing, Redis caching, and sliding-window rate limiting.
          </p>
        </div>
      </div>

      {/* Form Controls */}
      <form onSubmit={handleSendRequest} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="sm:col-span-2 space-y-1.5">
            <label className="block text-xs font-semibold text-slate-300">Prompt Payload</label>
            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Try a prompt, then send it again to see the cache hit"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all font-mono resize-none"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-slate-300">Model Selector</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-slate-200 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all font-mono"
            >
              <option value="llama-3.1-8b-instant">llama-3.1-8b-instant (Groq)</option>
              <option value="gemini-1.5-flash">gemini-1.5-flash (Gemini)</option>
              <option value="definitely-not-a-real-model">definitely-not-a-real-model (Trip Circuit)</option>
            </select>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={loading || !prompt.trim()}
            className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white text-xs font-bold px-6 py-2.5 rounded-xl transition-all shadow-lg shadow-purple-600/20 disabled:opacity-50 flex items-center space-x-2"
          >
            {loading ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>Executing API Request...</span>
              </>
            ) : (
              <>
                <span>Send Request</span>
                <span>🚀</span>
              </>
            )}
          </button>
        </div>
      </form>

      {/* Results Panel (Single-Shot: Last Request Only) */}
      {result && (
        <div className="space-y-4 pt-2 border-t border-slate-800/80 animate-fadeIn">
          {/* Labeled Stats Header Row */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 bg-slate-950/80 border border-slate-800 rounded-xl p-3 text-xs">
            <div>
              <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">Status Code</div>
              <div className="font-mono font-bold mt-0.5">
                <span
                  className={`px-2 py-0.5 rounded text-[11px] ${
                    result.statusCode === 200
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      : result.statusCode === 429
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                      : 'bg-red-500/20 text-red-300 border border-red-500/30'
                  }`}
                >
                  {result.statusCode} {result.statusCode === 200 ? 'OK' : result.statusCode === 429 ? 'Rate Limited' : result.statusCode === 503 ? 'Circuit Open' : 'Error'}
                </span>
              </div>
            </div>

            <div>
              <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">Cache Hit</div>
              <div className="font-mono font-semibold mt-0.5">
                {result.statusCode === 200 ? (
                  result.cacheHit ? (
                    <span className="px-2 py-0.5 rounded text-[11px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold">
                      ⚡ YES (~10ms)
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded text-[11px] bg-purple-500/20 text-purple-300 border border-purple-500/30">
                      NO (Miss)
                    </span>
                  )
                ) : (
                  <span className="text-slate-500">N/A</span>
                )}
              </div>
            </div>

            <div>
              <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">Provider</div>
              <div className="font-mono font-semibold text-slate-200 mt-0.5 uppercase">
                {result.provider || (result.cacheHit ? 'Cache' : 'N/A')}
              </div>
            </div>

            <div>
              <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">Latency</div>
              <div className="font-mono font-semibold text-indigo-400 mt-0.5">
                {result.latencyMs} ms
              </div>
            </div>

            <div>
              <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">Tokens Used</div>
              <div className="font-mono font-semibold text-slate-300 mt-0.5">
                {result.tokensUsed !== undefined ? `${result.tokensUsed} tokens` : '0 tokens'}
              </div>
            </div>
          </div>

          {/* Specific Error Banners */}
          {result.statusCode === 429 && (
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-medium flex items-center space-x-2">
              <span className="text-base">⚠️</span>
              <div>
                <strong>Rate limit reached — try again in a moment.</strong>
                <div className="text-[11px] text-amber-400/80 mt-0.5">
                  Sliding-window rate limiter blocked this request. Your tenant quota is currently exhausted.
                </div>
              </div>
            </div>
          )}

          {result.statusCode === 503 && (
            <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs font-medium flex items-center space-x-2">
              <span className="text-base">🔌</span>
              <div>
                <strong>Circuit breaker open — upstream provider temporarily unavailable.</strong>
                <div className="text-[11px] text-red-400/80 mt-0.5">
                  The gateway short-circuited this call in &lt;100ms to protect system stability.
                </div>
              </div>
            </div>
          )}

          {/* Response Payload Display */}
          <div className="space-y-1.5">
            <div className="text-xs font-semibold text-slate-400 flex items-center justify-between">
              <span>Gateway Response Output</span>
              {result.model && <span className="font-mono text-[10px] text-slate-500">{result.model}</span>}
            </div>
            <pre className="w-full bg-slate-950 border border-slate-800 rounded-xl p-4 text-xs font-mono text-slate-200 whitespace-pre-wrap overflow-x-auto max-h-48">
              {result.response || result.error || JSON.stringify(result, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};

export default ApiPlayground;
