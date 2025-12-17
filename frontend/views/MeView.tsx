
import React, { useState } from 'react';
import { UserState } from '../types';
import { formatNumber, getLevelLabel } from '../constants';
import { calculatePassiveIncome } from '../services/gameLogic';

interface MeViewProps {
  user: UserState;
  onSubscribeToggle: () => void;
}

const MeView: React.FC<MeViewProps> = ({ user, onSubscribeToggle }) => {
  const [showConfirm, setShowConfirm] = useState(false);
  const passive = calculatePassiveIncome(user.businesses);
  const level = getLevelLabel(user.coins);

  const handleToggleClick = () => {
    setShowConfirm(true);
  };

  const handleConfirm = () => {
    onSubscribeToggle();
    setShowConfirm(false);
  };

  return (
    <div className="h-full px-4 pt-8 pb-24 overflow-y-auto bg-slate-900 relative">
      <div className="flex flex-col items-center mb-8">
        <div className="w-24 h-24 bg-gradient-to-tr from-slate-700 to-slate-600 rounded-full flex items-center justify-center shadow-xl mb-4 border-4 border-slate-800 overflow-hidden">
          <img
            src="https://assets.zyrosite.com/mk3vgMQRxEcer7k1/toto_the-_ceo-Yle45r8kvWIVzwka.png"
            alt="Profile"
            className="w-full h-full object-cover"
          />
        </div>
        <h2 className="text-2xl font-bold text-white">{user.username}</h2>
        <div className="flex flex-col items-center mt-1">
             <span className="text-xs text-slate-500 font-mono">ID: {user.id}</span>
             <span className="px-3 py-1 bg-lime-500/10 text-lime-400 rounded-full text-xs font-bold mt-2 uppercase border border-lime-500/20">
              {level}
             </span>
        </div>
      </div>

      <div className="space-y-4">
        {/* Stats Card */}
        <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
            <h3 className="text-white font-bold mb-4">Profile Details</h3>
            
            <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-700/50 p-3 rounded-lg">
                    <div className="text-slate-400 text-xs mb-1">Total Balance</div>
                    <div className="text-white font-bold">{formatNumber(user.coins)}</div>
                </div>
                <div className="bg-slate-700/50 p-3 rounded-lg">
                    <div className="text-slate-400 text-xs mb-1">Passive Income</div>
                    <div className="text-lime-400 font-bold">+{formatNumber(passive)}</div>
                </div>
                <div className="bg-slate-700/50 p-3 rounded-lg">
                    <div className="text-slate-400 text-xs mb-1">Businesses</div>
                    <div className="text-white font-bold">{Object.values(user.businesses).reduce((a: number, b: number) => a + b, 0)}</div>
                </div>
                <div className="bg-slate-700/50 p-3 rounded-lg">
                    <div className="text-slate-400 text-xs mb-1">Referrals</div>
                    <div className="text-white font-bold">{user.referralsCount}</div>
                </div>
            </div>
        </div>

        {/* Settings Card */}
        <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
            <h3 className="text-white font-bold mb-4">Settings</h3>
            
            <div className="flex items-center justify-between">
                <div>
                    <div className="text-white font-medium">Notifications</div>
                    <div className="text-slate-400 text-xs">Receive updates & bonuses</div>
                </div>
                <button 
                    onClick={handleToggleClick}
                    className={`w-12 h-6 rounded-full p-1 transition-colors duration-200 ease-in-out ${user.subscribed ? 'bg-lime-500' : 'bg-slate-600'}`}
                >
                    <div className={`bg-white w-4 h-4 rounded-full shadow-md transform duration-200 ease-in-out ${user.subscribed ? 'translate-x-6' : ''}`}></div>
                </button>
            </div>
        </div>

        <div className="mt-8 text-center">
            <a href="https://www.cifcitoto.com/policy" className="text-indigo-400 text-sm hover:text-indigo-300">Terms of Service</a>
            <span className="mx-2 text-slate-600">•</span>
            <a href="https://www.cifcitoto.com/policy" className="text-indigo-400 text-sm hover:text-indigo-300">Privacy Policy</a>
            <div className="mt-4 text-xs text-slate-600">
                v1.0.1 • CEO TOTO Tycoon
            </div>
        </div>
      </div>

      {/* Confirmation Dialog */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
           <div className="bg-slate-800 rounded-2xl border border-slate-700 p-6 w-full max-w-xs shadow-2xl transform transition-all scale-100">
               <h3 className="text-lg font-bold text-white mb-2">
                 {user.subscribed ? 'Disable Notifications?' : 'Enable Notifications?'}
               </h3>
               <p className="text-slate-300 text-sm mb-6">
                 {user.subscribed 
                   ? "You might miss out on limited-time bonuses and leaderboard updates." 
                   : "Stay updated with the latest mining bonuses and team news."}
               </p>
               <div className="flex gap-3">
                 <button 
                   onClick={() => setShowConfirm(false)}
                   className="flex-1 px-4 py-3 rounded-xl bg-slate-700 text-white font-medium hover:bg-slate-600 transition-colors"
                 >
                   Cancel
                 </button>
                 <button 
                   onClick={handleConfirm}
                   className="flex-1 px-4 py-3 rounded-xl bg-lime-500 text-slate-900 font-bold hover:bg-lime-400 transition-colors"
                 >
                   Confirm
                 </button>
               </div>
           </div>
        </div>
      )}
    </div>
  );
};

export default MeView;
