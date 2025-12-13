
import React, { useState, useEffect } from 'react';
import { UserState, Tab } from './types';
import { BUSINESSES, MINE_COOLDOWN_MS } from './constants';
import BottomNav from './components/BottomNav';
import MineView from './views/MineView';
import LeaderboardView from './views/LeaderboardView';
import UpgradeView from './views/UpgradeView';
import TeamView from './views/TeamView';
import MeView from './views/MeView';
import { calculatePassiveIncome } from './services/gameLogic';
import { fetchUserProfile, updateUserProfile } from './services/api';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>(Tab.MINE);
  
  // State for data fetching
  const [user, setUser] = useState<UserState | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Initial Data Fetch
  useEffect(() => {
    const initUser = async () => {
      try {
        setIsLoading(true);
        setError(null);
        // REMOVED: const data = await fetchUserProfile('12345'); 
        // ADDED: No arguments needed, it grabs from Telegram now
        const data = await fetchUserProfile();
        setUser(data);
      } catch (err: any) {
        console.error("Error fetching user:", err);
        setError(err.message || "Failed to load profile");
      } finally {
        setIsLoading(false);
      }
    };

    initUser();
  }, []);

  // Save to Database whenever user state changes
  useEffect(() => {
    if (user) {
      // 1. Keep local storage for speed
      localStorage.setItem('toto_user', JSON.stringify(user));
      
      // 2. Save to Supabase (Debounce this in real production, but okay for now)
      updateUserProfile(user);
    }
  }, [user]);

  // Handle Mining Action
  const handleMine = (): { earned: number; passive: number } | null => {
    if (!user) return null;
    
    const now = Date.now();
    if (now - user.lastMine < MINE_COOLDOWN_MS) return null;

    // Logic from backend: earn random 2-3 coins + passive
    const earned = Math.floor(Math.random() * 1) + 0;
    const passive = calculatePassiveIncome(user.businesses);
    const newCoins = user.coins + earned + passive;

    setUser(prev => prev ? ({
      ...prev,
      coins: newCoins,
      lastMine: now
    }) : null);

    return { earned, passive };
  };

  // Handle Buying Businesses
  const handleBuyBusiness = (businessId: string) => {
    if (!user) return;

    const business = BUSINESSES.find(b => b.id === businessId);
    if (!business) return;

    if (user.coins >= business.cost) {
      const currentQty = user.businesses[businessId] || 0;
      setUser(prev => prev ? ({
        ...prev,
        coins: prev.coins - business.cost,
        businesses: {
          ...prev.businesses,
          [businessId]: currentQty + 1
        }
      }) : null);
    }
  };

  const handleSubscribeToggle = () => {
    if (!user) return;
    setUser(prev => prev ? ({ ...prev, subscribed: !prev.subscribed }) : null);
  };

  const renderContent = () => {
    if (!user) return null;

    switch (activeTab) {
      case Tab.MINE:
        return <MineView user={user} onMine={handleMine} />;
      case Tab.LEADERBOARD:
        return <LeaderboardView user={user} />;
      case Tab.UPGRADE:
        return <UpgradeView user={user} onBuy={handleBuyBusiness} />;
      case Tab.TEAM:
        return <TeamView user={user} />;
      case Tab.ME:
        return <MeView user={user} onSubscribeToggle={handleSubscribeToggle} />;
      default:
        return <MineView user={user} onMine={handleMine} />;
    }
  };

  // --- Loading State ---
  if (isLoading) {
    return (
      <div className="w-full h-screen bg-slate-900 flex flex-col items-center justify-center text-white">
        <div className="w-16 h-16 border-4 border-lime-500/30 border-t-lime-500 rounded-full animate-spin mb-4"></div>
        <h2 className="text-xl font-bold animate-pulse">Loading Empire...</h2>
        <p className="text-slate-400 text-sm mt-2">Connecting to blockchain</p>
      </div>
    );
  }

  // --- Error State ---
  if (error) {
    return (
      <div className="w-full h-screen bg-slate-900 flex flex-col items-center justify-center text-white px-6 text-center">
        <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mb-4">
          <span className="text-4xl">⚠️</span>
        </div>
        <h2 className="text-xl font-bold text-red-400 mb-2">Connection Failed</h2>
        <p className="text-slate-400 mb-6">{error}</p>
        <button 
          onClick={() => window.location.reload()}
          className="px-6 py-3 bg-slate-800 border border-slate-700 rounded-lg hover:bg-slate-700 transition-colors font-medium"
        >
          Try Again
        </button>
      </div>
    );
  }

  // --- Main App ---
  return (
    <div className="relative w-full h-screen bg-slate-900 text-white font-sans overflow-hidden">
        {/* Main Content Area */}
        <div className="h-full w-full">
            {renderContent()}
        </div>

        {/* Bottom Navigation */}
        <BottomNav currentTab={activeTab} onTabChange={setActiveTab} />
    </div>
  );
};

export default App;
