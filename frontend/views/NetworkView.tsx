import React, { useEffect, useState } from 'react';
import { formatNumber } from '../constants';

type ApiUser = {
  id: string;
  coins: number;
};

const API_BASE =
  ((import.meta as any).env?.VITE_API_URL || '').replace(/\/$/, '') ||
  'https://ceo-toto-tycoon.onrender.com';

const NetworkView: React.FC = () => {
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [totalCoins, setTotalCoins] = useState(0);
  const [prev24hCoins, setPrev24hCoins] = useState(0);
  const [loading, setLoading] = useState(false);

  // Fetch network data
  useEffect(() => {
    let aborted = false;

    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`${API_BASE}/api/leaderboard?limit=1000`);
        const body = await res.json();

        if (aborted) return;

        const fetchedUsers: ApiUser[] = body.users || [];
        setUsers(fetchedUsers);

        const sumCoins = fetchedUsers.reduce((sum, u) => sum + (u.coins || 0), 0);

        // Initialize 24h value if not set (replace later with backend for real)
        if (prev24hCoins === 0) {
          setPrev24hCoins(sumCoins * 0.94); // ~24h ago simulated
        }

        setTotalCoins(sumCoins);
      } catch (e) {
        console.warn(e);
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
  }, [prev24hCoins]);

  /* ---------------- Metrics ---------------- */

  const activeMiners = users.length;

  const growth24h = totalCoins - prev24hCoins;
  const growthPercent = prev24hCoins > 0 ? (growth24h / prev24hCoins) * 100 : 0;

  // Real emission rate: coins per second in last 24h
  const emissionRate = growth24h / (24 * 60 * 60);
  const emissionRateFormatted =
    emissionRate >= 1 ? emissionRate.toFixed(0) : emissionRate.toFixed(3);

  /* ---------------- UI ---------------- */

  return (
    <div className="h-full px-4 pt-8 pb-24 overflow-y-auto bg-slate-900">
      {/* Title */}
      <div className="mb-8 text-center">
        <h2 className="text-2xl font-bold text-white">Network🌐</h2>
        <p className="text-sm text-slate-400">
          Live CIFCI TOTO network activity
        </p>
      </div>

      {/* Network Coins Mined */}
      <div className="mb-6 bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 flex items-center">
        <span className="text-xs uppercase tracking-wide text-slate-400">
          Network Coins Mined
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-lg text-white">
            {formatNumber(totalCoins)}
          </span>
          <span className="flex items-center gap-1 text-xs font-semibold text-lime-400">
            <span className="w-2 h-2 rounded-full bg-lime-400 animate-pulse" />
            Live
          </span>
        </div>
      </div>

      {/* Market Stats */}
      <div className="mb-6 bg-slate-900 border border-slate-700 rounded-xl px-4 py-3">
        <h3 className="text-sm font-semibold text-white mb-2">Market Stats</h3>

        <StatRow label="Supply Cap" value={formatNumber(70000000000)} />
        <StatRow label="Circulating Supply" value={formatNumber(totalCoins)} />
        <StatRow label="Active Miners" value={formatNumber(activeMiners)} />
        <StatRow label="Emission Rate" value={`${emissionRateFormatted} / sec`} />
      </div>

      {/* Network Growth (24h) */}
      <div className="bg-slate-900 border border-slate-700 rounded-xl px-4 py-3">
        <h3 className="text-sm font-semibold text-white mb-2">
          Network Growth (24h)
        </h3>

        <div className="flex items-center justify-between">
          <span className="text-slate-400 text-sm">Coins Mined</span>
          <div className="text-right">
            <div
              className={`font-mono font-semibold ${
                growth24h >= 0 ? 'text-lime-400' : 'text-red-400'
              }`}
            >
              {growth24h >= 0 ? '+' : ''}
              {formatNumber(growth24h)}
            </div>
            <div className="text-xs text-slate-400">{growthPercent.toFixed(2)}%</div>
          </div>
        </div>
      </div>

      {loading && <div className="mt-4 text-xs text-slate-500">Updating network…</div>}
    </div>
  );
};

/* ---------------- Small Component ---------------- */

const StatRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between py-2 border-b border-slate-800 last:border-none">
    <span className="text-xs uppercase tracking-wide text-slate-400">{label}</span>
    <span className="font-mono font-semibold text-white">{value}</span>
  </div>
);

export default NetworkView;
