import React from 'react';
import { Link } from 'react-router-dom';

export const NotFound: React.FC = () => {
  return (
    <div className="min-h-[calc(100vh-73px)] flex flex-col items-center justify-center p-6 text-center bg-slate-950">
      <div className="text-6xl font-extrabold text-purple-500 mb-2">404</div>
      <h1 className="text-2xl font-bold text-white mb-2">Page Not Found</h1>
      <p className="text-sm text-slate-400 max-w-sm mb-6">
        The route you are looking for does not exist or has been moved.
      </p>
      <Link
        to="/dashboard"
        className="bg-purple-600 hover:bg-purple-500 text-white font-medium px-5 py-2.5 rounded-xl text-sm transition-all shadow-lg shadow-purple-600/25"
      >
        Return to Dashboard →
      </Link>
    </div>
  );
};

export default NotFound;
