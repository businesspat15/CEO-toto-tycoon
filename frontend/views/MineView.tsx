
import React, { useState, useEffect } from 'react';
import { UserState } from '../types';
import { calculatePassiveIncome } from '../services/gameLogic';
import { formatNumber, getLevelLabel, MINE_COOLDOWN_MS } from '../constants';

interface MineViewProps {
  user: UserState;
  onMine: () => { earned: number; passive: number } | null;
}

const MINING_FLAVORS = [
  "Tuning the pickaxe...",
  "Digging through the blockchain...",
  "Scanning the cache...",
  "Checking the veins of value...",
  "Calibrating miner...",
  "Validating blocks...",
];

const MineView: React.FC<MineViewProps> = ({ user, onMine }) => {
  const [timeLeft, setTimeLeft] = useState(0);
  const [isMining, setIsMining] = useState(false);
  const [flavorText, setFlavorText] = useState('');
  const [lastResult, setLastResult] = useState<{ earned: number; passive: number } | null>(null);

  const passiveIncome = calculatePassiveIncome(user.businesses);
  const levelLabel = getLevelLabel(user.coins);

  // Timer logic
  useEffect(() => {
    const updateTimer = () => {
      const now = Date.now();
      const diff = now - user.lastMine;
      const remaining = Math.max(0, MINE_COOLDOWN_MS - diff);
      setTimeLeft(remaining);
    };

    updateTimer(); // Initial check
    const timer = setInterval(updateTimer, 100); // Faster update for smoother bar
    return () => clearInterval(timer);
  }, [user.lastMine]);

  const progressPercent = Math.min(100, ((MINE_COOLDOWN_MS - timeLeft) / MINE_COOLDOWN_MS) * 100);
  const isReady = timeLeft === 0;

  const handleMineClick = async () => {
    if (!isReady || isMining) return;

    setIsMining(true);
    setLastResult(null);
    setFlavorText(MINING_FLAVORS[Math.floor(Math.random() * MINING_FLAVORS.length)]);

    // Simulate work delay
    await new Promise(resolve => setTimeout(resolve, 1500));

    const result = onMine();
    
    setIsMining(false);
    if (result) {
      setLastResult(result);
    }
  };

  const handleAdClick = () => {
    // In a real implementation, this would trigger an ad provider
    alert("Ad Video Placeholder: Watching ad for boost...");
  };

  return (
    <div className="flex flex-col items-center h-full px-4 pt-8 pb-24 overflow-y-auto bg-gradient-to-b from-slate-900 to-slate-800">
      {/* Header Info */}
      <div className="w-full flex justify-between items-center mb-8">
        <div className="flex flex-col">
          <span className="text-slate-400 text-sm">Passive Income</span>
          <span className="text-lime-400 font-bold">+{formatNumber(passiveIncome)}/mine</span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-slate-400 text-sm">Level</span>
          <span className="text-white font-bold">{levelLabel}</span>
        </div>
      </div>

      {/* Main Balance */}
      <div className="flex flex-col items-center mb-8">
        <div className="w-20 h-20 bg-lime-500/20 rounded-full flex items-center justify-center mb-4 ring-2 ring-lime-500/50 shadow-[0_0_20px_rgba(132,204,22,0.3)]">
          <span className="text-4xl animate-bounce-short">💰</span>
        </div>
        <h1 className="text-4xl font-extrabold text-white tracking-tight">{formatNumber(user.coins)}</h1>
        <span className="text-slate-400 uppercase tracking-widest text-xs mt-1">Total Balance</span>
      </div>

     
      {/* Mining Interaction */}
      <div className="flex-1 flex flex-col justify-center items-center w-full max-w-sm">
        <div className="relative w-64 h-64">
           {/* Ripple Effect Background when Ready */}
           {isReady && !isMining && (
            <div className="absolute inset-0 rounded-full bg-lime-500/20 animate-ping opacity-75"></div>
           )}
           
           {/* Mining Button */}
          <button
            onClick={handleMineClick}
            disabled={!isReady || isMining}
            className={`relative w-full h-full rounded-full flex flex-col items-center justify-center shadow-2xl border-4 transition-all duration-300 active:scale-95 overflow-hidden ${
              isMining 
                ? 'bg-slate-800 border-lime-500/50 cursor-wait'
                : isReady
                  ? 'bg-gradient-to-br from-lime-500 to-green-700 border-lime-300 cursor-pointer hover:shadow-[0_0_40px_rgba(132,204,22,0.5)]'
                  : 'bg-slate-700 border-slate-600 cursor-not-allowed opacity-80'
            }`}
          >
            {isMining ? (
              <>
                 <div className="animate-spin text-4xl mb-4">⚙️</div>
                 <span className="text-lime-400 font-bold text-center px-4 animate-pulse">
                   {flavorText}
                 </span>
              </>
            ) : (
              <>
                <span className="text-6xl filter drop-shadow-md mb-2">
                  {isReady ? '⛏️' : '⏳'}
                </span>
                <span className={`font-bold text-lg uppercase tracking-wide ${isReady ? 'text-white' : 'text-slate-400'}`}>
                  {isReady ? 'Mine Now' : 'Cooling Down'}
                </span>
              </>
            )}
          </button>
        </div>

        {/* Cooldown Timer Bar */}
        <div className="w-full mt-10 px-4">
          <div className="flex justify-between text-xs font-mono mb-2">
            <span className="text-slate-400">Energy Status</span>
            <span className={isReady ? 'text-lime-400 font-bold' : 'text-orange-400'}>
              {isReady ? 'READY' : `${Math.ceil(timeLeft / 1000)}s`}
            </span>
          </div>
          <div className="relative w-full h-4 bg-slate-800 rounded-full overflow-hidden border border-slate-700 shadow-inner">
            {/* Background Grid Pattern for style */}
            <div className="absolute inset-0 opacity-10" 
                 style={{ backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 5px, #fff 5px, #fff 10px)' }}>
            </div>
            
            {/* Progress Fill */}
            <div
              className={`h-full transition-all duration-300 ease-out flex items-center justify-end pr-1 ${
                isReady 
                  ? 'bg-gradient-to-r from-lime-600 to-lime-400 shadow-[0_0_15px_rgba(132,204,22,0.5)]' 
                  : 'bg-gradient-to-r from-orange-700 to-orange-500'
              }`}
              style={{ width: `${progressPercent}%` }}
            >
              {/* Highlight effect on the leading edge */}
              <div className="w-1 h-full bg-white/30"></div>
            </div>
          </div>
        </div>
      </div>

      {/* Advertisement Block */}
      <div className="w-full max-w-sm mt-6">
        <button 
          onClick={handleAdClick}
          className="relative w-full overflow-hidden bg-gradient-to-r from-indigo-900/60 to-slate-800 border border-indigo-500/30 rounded-xl p-4 flex items-center justify-between shadow-lg cursor-pointer hover:border-indigo-400 transition-all group active:scale-[0.98]"
        >
           {/* Decorative Blur */}
           <div className="absolute -right-8 -top-8 w-24 h-24 bg-indigo-500/20 rounded-full blur-2xl pointer-events-none"></div>

           <div className="flex items-center gap-4 relative z-10">
             <div className="w-10 h-10 bg-indigo-500/20 rounded-lg flex items-center justify-center text-xl shadow-inner border border-indigo-500/20">
               📺
             </div>
             <div className="flex flex-col items-start">
               <span className="text-indigo-300 text-[10px] font-bold uppercase tracking-wider">Sponsored</span>
               <span className="text-white font-bold text-sm group-hover:text-indigo-200 transition-colors">Watch channel Ads</span>
             </div>
           </div>

           <div className="relative z-10 bg-slate-700/50 p-2 rounded-full text-indigo-300 group-hover:text-white group-hover:bg-indigo-500 transition-colors">
             <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
               <path d="M5 12h14"/>
               <path d="m12 5 7 7-7 7"/>
             </svg>
           </div>
        </button>
      </div>
    </div>
  );
};

export default MineView;
