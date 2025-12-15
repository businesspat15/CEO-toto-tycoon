export enum Tab {
  MINE = 'Mine',
  LEADERBOARD = 'NetworkView',
  UPGRADE = 'Asset',
  TEAM = 'Team',
  ME = 'Me'
}

export interface BusinessDef {
  id: string;
  name: string;
  cost: number;
  income: number;
}

export interface UserState {
  id: string;
  username: string;
  coins: number;
  businesses: Record<string, number>; // Business ID -> Quantity
  level: number;
  lastMine: number; // Timestamp
  referredBy: string | null;
  referralsCount: number;
  subscribed: boolean;
}