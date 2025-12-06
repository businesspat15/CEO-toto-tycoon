import React, { useEffect, useState } from 'react';
import { UserState } from '../types';
import { formatNumber } from '../constants';

interface LeaderboardViewProps {
  user: UserState;
}

type ApiUser = {
  id: string;
  username: string;
  coins: number;
  businesses?: Record<string, number>;
  level?: number;
};

const API_BASE = (import.meta as any).env?.VITE_API_BASE || 'http://localhost:3000';

const LeaderboardView: React.FC<LeaderboardViewProps> = ({ user }) => {
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch leaderboard from backend
  useEffect(() => {
    let aborted = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${API_BASE}/api/leaderboard?limit=50`, {
          credentials: 'include'
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!aborted) {
          let fetchedUsers: ApiUser[] = body.users || [];

          // Include current user if missing
          if (!fetchedUsers.find(u => u.id === user.id || u.username === user.username)) {
            fetchedUsers.push({ id: user.id, username: user.username, coins: user.coins });
          }

          // Sort descending by coins
          fetchedUsers.sort((a, b) => b.coins - a.coins);

          setUsers(fetchedUsers);
        }
      } catch (err: any) {
        if (!aborted) setError(err?.message || 'Failed to load');
      } finally {
        if (!aborted) setLoading(false);
      }
    }

    load();
    const timer = setInterval(load, 10000); // refresh every 10s
    return () => {
      aborted = true;
      clearInterval(timer);
    };
  }, [user]);

  const userIndex = users.findIndex(u => u.id === user.id || u.username === user.username);
  const userRank = userIndex >= 0 ? userIndex + 1 : users.length + 1;

  return (
    <div className="h-full px-4 pt-8 pb-24 overflow-y-auto bg-slate-900">
      <div className="flex flex-col items-center mb-8">
        <h2 className="text-2xl font-bold text-white mb-2">Leaderboard 🏆</h2>
        <p className="text-slate-400 text-sm">Top CEOs of TOTO Tycoon</p>
      </div>

      <div className="bg-slate-800/50 rounded-xl border border-slate-700 overflow-hidden">
        <div className="bg-gradient-to-r from-lime-900/40 to-slate-800 p-4 border-b border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-lime-500 flex items-center justify-center text-slate-900 font-bold text-sm">
              #{userRank}
            </div>
            <div className="flex flex-col">
              <span className="font-bold text-white">You</span>
              <span className="text-xs text-lime-400">{formatNumber(user.coins)} coins</span>
            </div>
          </div>
          <div>
            <button
              onClick={() => {
                (async () => {
                  try {
                    const res = await fetch(`${API_BASE}/api/leaderboard?limit=50`, { credentials: 'include' });
                    const body = await res.json();
                    let fetchedUsers: ApiUser[] = body.users || [];
                    if (!fetchedUsers.find(u => u.id === user.id || u.username === user.username)) {
                      fetchedUsers.push({ id: user.id, username: user.username, coins: user.coins });
                    }
                    fetchedUsers.sort((a, b) => b.coins - a.coins);
                    setUsers(fetchedUsers);
                  } catch (e) {
                    console.warn(e);
                  }
                })();
              }}
              className="text-xs px-3 py-1 rounded bg-slate-700 text-slate-200 hover:bg-slate-600"
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="divide-y divide-slate-700/50">
          {loading && <div className="p-4 text-slate-400">Loading...</div>}
          {error && <div className="p-4 text-red-400">Error: {error}</div>}
          {!loading && users.length === 0 && !error && <div className="p-4 text-slate-400">No players yet.</div>}

          {users.map((u, idx) => {
            const rank = idx + 1;
            const isMe = u.id === user.id || u.username === user.username;

            let medal = null;
            if (rank === 1) medal = '🥇';
            if (rank === 2) medal = '🥈';
            if (rank === 3) medal = '🥉';

            return (
              <div key={`${u.id}-${idx}`} className={`flex items-center justify-between p-4 ${isMe ? 'bg-white/5' : ''}`}>
                <div className="flex items-center gap-4">
                  <div className="w-6 text-center font-mono text-slate-500 font-bold">{medal || rank}</div>
                  <div className="flex flex-col">
                    <span className={`font-medium ${isMe ? 'text-lime-400' : 'text-slate-200'}`}>{u.username}</span>
                    {u.businesses && (
                      <span className="text-xs text-slate-500">
                        {Object.entries(u.businesses).map(([k,v]) => `${k}:${v}`).join(' • ')}
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-slate-300 font-mono text-sm tracking-wide">{formatNumber(u.coins)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default LeaderboardView;
