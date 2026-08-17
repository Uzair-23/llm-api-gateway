import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import {
  isAuthenticated,
  getTenant,
  getApiKeyPrefix,
  rotateKey,
  getUsageStats,
  getLimits,
} from '../../services/api.service';
import type {
  TenantData,
  UsageStatsResponse,
  LimitResponse,
} from '../../types/api.types';
import { ApiPlayground } from '../../components/ApiPlayground';

const COLORS = ['#a855f7', '#6366f1'];

export const DashboardPage: React.FC = () => {
  const navigate = useNavigate();
  const [tenant, setTenantState] = useState<TenantData | null>(null);
  const [apiKeyPrefix, setPrefixState] = useState<string>('');
  const [usageStats, setUsageStats] = useState<UsageStatsResponse | null>(null);
  const [limits, setLimits] = useState<LimitResponse | null>(null);

  const [loading, setLoading] = useState(true);
  const [rotating, setRotating] = useState(false);
  const [newRotatedKey, setNewRotatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [statsData, limitsData] = await Promise.all([
        getUsageStats(),
        getLimits(),
      ]);
      setUsageStats(statsData);
      setLimits(limitsData);
    } catch (_err) {
      console.error('Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isAuthenticated()) {
      navigate('/auth/login');
      return;
    }
    const t = getTenant();
    setTenantState(t);
    const prefix = getApiKeyPrefix() || (t?.apiKeyPrefix ?? 'sk-live-****');
    setPrefixState(prefix);
    fetchData();
  }, [navigate]);

  const handleRotateKey = async () => {
    setRotateError(null);
    setRotating(true);
    try {
      const res = await rotateKey();
      setNewRotatedKey(res.apiKey);
      setPrefixState(res.apiKeyPrefix || res.apiKey.slice(0, 11) + '...');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setRotateError(axiosErr.response?.data?.error || 'API Key rotation failed.');
      } else {
        setRotateError('Failed to rotate API Key. Network error.');
      }
    } finally {
      setRotating(false);
    }
  };

  const handleCopyNewKey = () => {
    if (newRotatedKey) {
      navigator.clipboard.writeText(newRotatedKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  const currentUsagePct = Math.min(
    100,
    Math.round(((limits?.currentUsage || 0) / (limits?.rateLimitPerMin || 100)) * 100),
  );

  return (
    <div className="min-h-[calc(100vh-73px)] bg-slate-950 p-6 sm:p-8 space-y-8 max-w-7xl mx-auto">
      {/* Overview Top Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 backdrop-blur-xl">
        <div>
          <div className="flex items-center space-x-3">
            <h1 className="text-2xl font-bold text-white tracking-tight">API Management Console</h1>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider bg-purple-500/10 text-purple-400 border border-purple-500/20">
              {tenant?.planTier || 'Free'} Tier
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Logged in as <span className="text-slate-200 font-mono">{tenant?.email || 'tenant'}</span>
          </p>
        </div>

        {/* API Key Box */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 bg-slate-950/80 border border-slate-800 rounded-xl p-3.5">
          <div>
            <div className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">Active API Key</div>
            <div className="font-mono text-xs text-purple-300 font-semibold">{apiKeyPrefix || 'sk-live-ab12...'}</div>
          </div>
          <button
            onClick={handleRotateKey}
            disabled={rotating}
            className="bg-purple-600/90 hover:bg-purple-500 text-white text-xs font-medium px-3.5 py-2 rounded-lg transition-all shadow-md shadow-purple-600/20 disabled:opacity-50 flex items-center justify-center space-x-1.5"
          >
            {rotating ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>Rotating...</span>
              </>
            ) : (
              <span>Rotate Key 🔄</span>
            )}
          </button>
        </div>
      </div>

      {/* Rotation Success Banner */}
      {newRotatedKey && (
        <div className="p-5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-200 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2 font-bold text-amber-400 text-sm">
              <span>⚠️ API Key Rotated Successfully!</span>
            </div>
            <button
              onClick={() => setNewRotatedKey(null)}
              className="text-xs text-amber-400 hover:text-amber-200"
            >
              Dismiss ✕
            </button>
          </div>
          <p className="text-xs text-slate-300">
            Your previous API key has been <strong>invalidated immediately</strong>. Save your new key now — it will not be displayed again!
          </p>
          <div className="flex items-center space-x-2">
            <input
              type="text"
              readOnly
              value={newRotatedKey}
              className="w-full bg-slate-950 border border-amber-500/40 rounded-xl px-3.5 py-2 text-xs font-mono text-amber-300 focus:outline-none"
            />
            <button
              onClick={handleCopyNewKey}
              className="bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold px-4 py-2 rounded-xl transition-all whitespace-nowrap"
            >
              {copied ? 'Copied! ✓' : 'Copy New Key'}
            </button>
          </div>
        </div>
      )}

      {rotateError && (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-medium">
          ⚠️ {rotateError}
        </div>
      )}

      {/* API Playground Panel */}
      <ApiPlayground onRequestComplete={fetchData} />

      {/* Analytics Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-5 backdrop-blur-xl space-y-1">
          <div className="text-xs text-slate-400 font-medium">Total Requests</div>
          <div className="text-3xl font-extrabold text-white tracking-tight">
            {loading ? '...' : (usageStats?.totalRequests ?? 0).toLocaleString()}
          </div>
          <div className="text-[11px] text-purple-400/90 font-medium">24h Sliding Window</div>
        </div>

        <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-5 backdrop-blur-xl space-y-1">
          <div className="text-xs text-slate-400 font-medium">Cache Hit Rate</div>
          <div className="text-3xl font-extrabold text-emerald-400 tracking-tight">
            {loading ? '...' : `${usageStats?.cacheHitRate ?? 0}%`}
          </div>
          <div className="text-[11px] text-slate-400">Response Cache (~10ms)</div>
        </div>

        <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-5 backdrop-blur-xl space-y-1">
          <div className="text-xs text-slate-400 font-medium">Average Latency</div>
          <div className="text-3xl font-extrabold text-indigo-400 tracking-tight">
            {loading ? '...' : `${usageStats?.averageLatencyMs ?? 0}ms`}
          </div>
          <div className="text-[11px] text-slate-400">Gateway + Upstream</div>
        </div>

        <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-5 backdrop-blur-xl space-y-1">
          <div className="text-xs text-slate-400 font-medium">Upstream Circuit Breaker</div>
          <div className="text-lg font-bold text-emerald-400 flex items-center space-x-2 pt-1">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>Closed (Normal)</span>
          </div>
          <div className="text-[11px] text-slate-400">Groq Primary / Gemini Fallback</div>
        </div>
      </div>

      {/* Analytics Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Chart: Requests & Cache Hits Over Time */}
        <div className="lg:col-span-2 bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 backdrop-blur-xl space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold text-white">Traffic & Cache Performance</h3>
              <p className="text-xs text-slate-400">Requests over time vs instant cache hits</p>
            </div>
            <div className="flex items-center space-x-4 text-xs font-medium">
              <div className="flex items-center space-x-1.5 text-purple-400">
                <span className="w-2.5 h-2.5 rounded-full bg-purple-500" />
                <span>Total Requests</span>
              </div>
              <div className="flex items-center space-x-1.5 text-emerald-400">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                <span>Cache Hits</span>
              </div>
            </div>
          </div>

          <div className="h-64 w-full">
            {loading ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-500">Loading chart...</div>
            ) : usageStats && usageStats.requestsOverTime && usageStats.requestsOverTime.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={usageStats.requestsOverTime} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorReq" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0.0} />
                    </linearGradient>
                    <linearGradient id="colorCache" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="time" stroke="#64748b" fontSize={11} />
                  <YAxis stroke="#64748b" fontSize={11} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '12px', fontSize: '12px' }}
                    itemStyle={{ color: '#f8fafc' }}
                  />
                  <Area type="monotone" dataKey="requests" stroke="#8b5cf6" strokeWidth={2} fillOpacity={1} fill="url(#colorReq)" name="Total Requests" />
                  <Area type="monotone" dataKey="cacheHits" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorCache)" name="Cache Hits" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex flex-col items-center justify-center space-y-2 border border-dashed border-slate-800 rounded-xl p-4">
                <div className="text-2xl">📊</div>
                <div className="text-xs font-semibold text-slate-300">No requests recorded in 24h window</div>
                <div className="text-[11px] text-slate-500 text-center max-w-xs">
                  Send requests using your API key to <code className="text-purple-400">/v1/chat/completions</code> to see live performance analytics here!
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Secondary Chart: Provider Distribution */}
        <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 backdrop-blur-xl space-y-4">
          <div>
            <h3 className="text-base font-bold text-white">Upstream Routing</h3>
            <p className="text-xs text-slate-400">Groq primary vs Gemini fallback</p>
          </div>

          <div className="h-64 w-full flex items-center justify-center">
            {loading ? (
              <div className="text-xs text-slate-500">Loading distribution...</div>
            ) : usageStats && usageStats.providerDistribution && usageStats.providerDistribution.some(p => p.value > 0) ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={usageStats.providerDistribution}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={80}
                    paddingAngle={4}
                    dataKey="value"
                  >
                    {usageStats.providerDistribution.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '12px', fontSize: '12px' }}
                  />
                  <Legend verticalAlign="bottom" height={36} iconType="circle" />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full w-full flex flex-col items-center justify-center space-y-2 border border-dashed border-slate-800 rounded-xl p-4">
                <div className="text-2xl">🤖</div>
                <div className="text-xs font-semibold text-slate-300">No upstream calls yet</div>
                <div className="text-[11px] text-slate-500 text-center">
                  Direct provider calls (uncached) will populate routing breakdown.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Rate Limits & Quota Section */}
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 backdrop-blur-xl space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-bold text-white">Rate Limit & Window Quota</h3>
            <p className="text-xs text-slate-400">Sliding-window rate limiter state (Redis atomic Lua script enforced)</p>
          </div>
          <div className="text-xs font-mono text-purple-400 bg-purple-500/10 border border-purple-500/20 px-3 py-1 rounded-lg">
            Limit: {limits?.rateLimitPerMin ?? 100} req / min
          </div>
        </div>

        {/* Progress Bar */}
        <div className="space-y-2">
          <div className="flex justify-between text-xs font-medium">
            <span className="text-slate-300">
              Current Window Usage: <strong className="text-white">{limits?.currentUsage ?? 0}</strong> / {limits?.rateLimitPerMin ?? 100} requests
            </span>
            <span className={currentUsagePct > 85 ? 'text-red-400 font-bold' : 'text-purple-400 font-bold'}>
              {currentUsagePct}% Used
            </span>
          </div>

          <div className="w-full h-3 bg-slate-950 border border-slate-800 rounded-full overflow-hidden p-0.5">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                currentUsagePct > 90
                  ? 'bg-red-500 shadow-md shadow-red-500/40'
                  : currentUsagePct > 70
                  ? 'bg-amber-500'
                  : 'bg-gradient-to-r from-purple-500 to-indigo-500 shadow-md shadow-purple-500/30'
              }`}
              style={{ width: `${currentUsagePct}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default DashboardPage;
