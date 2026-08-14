import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { signup, isAuthenticated } from '../../services/api.service';

export const SignupPage: React.FC = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [createdApiKey, setCreatedApiKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isAuthenticated() && !createdApiKey) {
      navigate('/dashboard');
    }
  }, [navigate, createdApiKey]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email || !password || !confirmPassword) {
      setError('All fields are required.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters long.');
      return;
    }

    setLoading(true);
    try {
      const data = await signup(email, password);
      if (data.apiKey) {
        setCreatedApiKey(data.apiKey);
      } else {
        navigate('/dashboard');
      }
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setError(axiosErr.response?.data?.error || 'Signup failed. Please try again.');
      } else {
        setError('Network error. Is the gateway backend running on port 4000?');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCopyKey = () => {
    if (createdApiKey) {
      navigator.clipboard.writeText(createdApiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  const handleContinueToDashboard = () => {
    navigate('/dashboard');
  };

  return (
    <div className="min-h-[calc(100vh-73px)] flex items-center justify-center px-4 py-12 bg-slate-950">
      <div className="w-full max-w-md bg-slate-900/80 border border-slate-800 backdrop-blur-xl rounded-2xl p-8 shadow-2xl shadow-purple-950/20">
        {!createdApiKey ? (
          <>
            <div className="text-center mb-8">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-purple-600/20 border border-purple-500/30 text-purple-400 mb-3 text-xl font-bold">
                ⚡
              </div>
              <h1 className="text-2xl font-bold text-white tracking-tight">Create Tenant Account</h1>
              <p className="text-sm text-slate-400 mt-1">Get immediate API access to Groq & Gemini via gateway</p>
            </div>

            {error && (
              <div className="mb-6 p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-medium flex items-center space-x-2">
                <span>⚠️</span>
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">Email Address</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="tenant@example.com"
                  required
                  className="w-full bg-slate-950/70 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  className="w-full bg-slate-950/70 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">Confirm Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  className="w-full bg-slate-950/70 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full mt-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-medium py-2.5 rounded-xl text-sm shadow-lg shadow-purple-600/25 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2"
              >
                {loading ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>Creating Account...</span>
                  </>
                ) : (
                  <span>Sign Up & Get API Key</span>
                )}
              </button>
            </form>

            <div className="mt-8 text-center text-xs text-slate-400">
              Already have an account?{' '}
              <Link to="/auth/login" className="text-purple-400 font-medium hover:underline">
                Sign in
              </Link>
            </div>
          </>
        ) : (
          /* One-Time API Key Display Screen */
          <div className="space-y-6 text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-2xl">
              🎉
            </div>
            <div>
              <h2 className="text-2xl font-bold text-white tracking-tight">Account Created!</h2>
              <p className="text-xs text-slate-400 mt-1">Here is your live API key for machine-to-machine traffic</p>
            </div>

            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-medium text-left space-y-1">
              <div className="flex items-center space-x-1.5 font-bold text-amber-400">
                <span>⚠️ Important Security Notice</span>
              </div>
              <p>Save your API key now in a secure place. You will <strong>never see it again</strong> after leaving this page!</p>
            </div>

            <div className="space-y-2 text-left">
              <label className="block text-xs font-medium text-slate-400">Your Live API Key</label>
              <div className="flex items-center space-x-2">
                <input
                  type="text"
                  readOnly
                  value={createdApiKey}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-purple-300 font-mono select-all focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleCopyKey}
                  className="bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium px-4 py-2.5 rounded-xl transition-all whitespace-nowrap shadow-md shadow-purple-600/20"
                >
                  {copied ? 'Copied! ✓' : 'Copy Key'}
                </button>
              </div>
            </div>

            <button
              onClick={handleContinueToDashboard}
              className="w-full mt-4 bg-slate-800 hover:bg-slate-700 text-white font-medium py-2.5 rounded-xl text-sm border border-slate-700 transition-all"
            >
              Continue to Dashboard →
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default SignupPage;
