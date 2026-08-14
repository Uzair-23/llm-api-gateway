import React from 'react';
import { useNavigate } from 'react-router-dom';
import { getTenant, logout, isAuthenticated } from '../services/api.service';

export const Header: React.FC = () => {
  const navigate = useNavigate();
  const tenant = getTenant();
  const authenticated = isAuthenticated();

  const handleLogout = () => {
    logout();
    navigate('/auth/login');
  };

  return (
    <header className="sticky top-0 z-50 backdrop-blur-md bg-slate-950/80 border-b border-slate-800/80 px-6 py-4 transition-all">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        {/* Brand Logo */}
        <div
          onClick={() => navigate(authenticated ? '/dashboard' : '/auth/login')}
          className="flex items-center space-x-3 cursor-pointer group"
        >
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-purple-600 to-indigo-500 flex items-center justify-center shadow-lg shadow-purple-500/20 group-hover:scale-105 transition-transform">
            <span className="text-white font-bold text-lg">⚡</span>
          </div>
          <div>
            <span className="text-xl font-bold bg-gradient-to-r from-white via-slate-200 to-purple-400 bg-clip-text text-transparent">
              LLM API Gateway
            </span>
            <span className="block text-[10px] text-purple-400/80 font-mono font-medium tracking-wider uppercase">
              Tenant Dashboard
            </span>
          </div>
        </div>

        {/* User / Tenant Info & Actions */}
        {authenticated && (
          <div className="flex items-center space-x-4">
            {tenant?.email && (
              <div className="hidden sm:flex items-center space-x-2 bg-slate-900/90 border border-slate-800 rounded-full px-3 py-1 text-xs">
                <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-slate-300 font-mono">{tenant.email}</span>
              </div>
            )}

            {tenant?.planTier && (
              <span className="uppercase text-[11px] font-bold tracking-wider px-2.5 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/30">
                {tenant.planTier} Plan
              </span>
            )}

            <button
              onClick={handleLogout}
              className="text-xs font-semibold text-slate-400 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 px-3.5 py-1.5 rounded-lg transition-all"
            >
              Sign Out
            </button>
          </div>
        )}
      </div>
    </header>
  );
};

export default Header;
