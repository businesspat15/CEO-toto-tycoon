import { BusinessDef } from './types';

// Derived from index.js provided by user
export const BUSINESSES: BusinessDef[] = [
  { id: 'DAPP', name: 'CIFCI Tech & AI', cost: 1000, income: 1 },
  { id: 'TOTO_VAULT', name: 'CIFCI Crypto & Blockchain', cost: 1000, income: 1 },
  { id: 'CIFCI_STABLE', name: 'CIFCI Real Estate', cost: 1000, income: 1 },
  { id: 'TYPOGRAM', name: 'CIFCI Energy', cost: 1000, income: 1 },
  { id: 'APPLE', name: 'CIFCI Infrastructure', cost: 1000, income: 1 },
  { id: 'BITCOIN', name: 'CIFCI Space & Exploration', cost: 1000, income: 1 },
];

export const MINE_COOLDOWN_MS = 60000; // 1 minute

export const getLevelLabel = (coins: number): string => {
  if (coins < 1000) return "Intern";
  if (coins < 10000) return "Manager";
  if (coins < 100000) return "CEO";
  if (coins < 700000) return "Tycoon";
  return "CEO TOTO 💎";
};

export const formatNumber = (n: number): string => {
  return n.toLocaleString("en-IN");
};