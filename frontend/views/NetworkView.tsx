import React, { useEffect, useState } from 'react';
import { formatNumber } from '../constants';

type NetworkStats = {
  totalCoins: number;
  coins24hAgo: number;
  activeMiners: number;
};

const API_BASE =
  ((import.meta as any).env?.VITE_API_URL || '').replace(/\/$/, '') ||
  'https://ceo-toto-tycoon.onrender.com';

const NetworkView: React.FC = () => {
  const [stats, setStats] = useState<NetworkStats>({
    totalCoins: 0,
    coins24hAgo: 0,
    activeMiners: 0
  });
  const [loading, setLoading] = useState(false);

  // Fetch real network stats
  useEffect(() => {
    let aborted = false;

    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`${API_BASE}/api/network-stats`);
        const body = await res.json();
        if (aborted) return;

        setStats({
          totalCoins: body.totalCoins || 0,
          coins24hAgo: body.coins24hAgo || 0,
          activeMiners: body.activeMiners || 0
        });
      } catch (e) {
        console.warn('Failed to load network stats', e);
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
  }, []);

  const growth24h = stats.totalCoins - stats.coins24hAgo;
  const growthPercent =
    stats.coins24hAgo > 0 ? (growth24h / stats.coins24hAgo) * 100 : 0;

  const emissionRate = Math.max(1, Math.floor(growth24h / 86400)); // coins/sec over 24h

  return (
    <div className="h-full px-4 pt-8 pb-24 overflow-y-auto bg-slate-900">
      {/* Title */}
      <div className="mb-8 text-center">
        <h2 className="text-2xl font-bold text-white">Network🌐</h2>
        <p className="text-sm text-slate-400">Live CIFCI TOTO network activity</p>
      </div>

      {/* Network Coins Mined */}
      <div className="mb-6 bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 flex items-center">
        <span className="text-xs uppercase tracking-wide text-slate-400">
          Network Coins Mined
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-lg text-white">
            {formatNumber(stats.totalCoins)}
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
        <StatRow label="Circulating Supply" value={formatNumber(stats.totalCoins)} />
        <StatRow label="Active Miners" value={formatNumber(stats.activeMiners)} />
        <StatRow label="Emission Rate" value={`${formatNumber(emissionRate)} / sec`} />
      </div>

      {/* Network Growth (24h) */}
      <div className="bg-slate-900 border border-slate-700 rounded-xl px-4 py-3">
        <h3 className="text-sm font-semibold text-white mb-2">Network Growth (24h)</h3>
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

      {loading && (
        <div className="mt-4 text-xs text-slate-500">Updating network…</div>
      )}
    </div>
  );
};

/* ---------------- Small Component ---------------- */

const StatRow: React.FC<{ label: string; value: string | number }> = ({
  label,
  value
}) => (
  <div className="flex items-center justify-between py-2 border-b border-slate-800 last:border-none">
    <span className="text-xs uppercase tracking-wide text-slate-400">{label}</span>
    <span className="font-mono font-semibold text-white">{value}</span>
  </div>
);

export default NetworkView;
