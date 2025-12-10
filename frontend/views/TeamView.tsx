import React from 'react';
import { UserState } from '../types';
import { formatNumber } from '../constants';

interface TeamViewProps {
  user: UserState;
}

const TeamView: React.FC<TeamViewProps> = ({ user }) => {
  const referralLink = `https://t.me/Mine_cifcitotobot?start=ref_${user.id}`;
  
  const handleCopy = () => {
     navigator.clipboard.writeText(referralLink);
     alert("Referral link copied to clipboard!");
  };

  return (
    <div className="h-full px-4 pt-8 pb-24 overflow-y-auto bg-slate-900">
      <div className="flex flex-col items-center mb-8">
        <h2 className="text-2xl font-bold text-white mb-2">Team & Referrals 🤝</h2>
        <p className="text-slate-400 text-center text-sm">Invite friends to build your TOTO empire together.</p>
      </div>

      <div className="bg-gradient-to-br from-indigo-900 to-slate-800 rounded-2xl p-6 border border-indigo-700/50 mb-8 relative overflow-hidden">
        <div className="absolute top-0 right-0 -mt-4 -mr-4 w-24 h-24 bg-indigo-500/20 rounded-full blur-2xl"></div>
        
        <h3 className="text-xl font-bold text-white mb-4">Invite Bonus</h3>
        <div className="flex items-center gap-4 mb-4">
            <div className="w-12 h-12 rounded-full bg-indigo-500/20 flex items-center justify-center text-2xl">🎁</div>
            <div>
                <p className="text-white font-medium">Earn 100 coins</p>
                <p className="text-indigo-200 text-sm">for every friend you invite and Follow X.</p>
            </div>
        </div>
      </div>

      <div className="bg-slate-800 rounded-xl p-4 border border-slate-700 mb-6">
        <h4 className="text-sm text-slate-400 uppercase tracking-wider mb-2">Your Stats</h4>
        <div className="flex justify-between items-center py-2 border-b border-slate-700/50">
            <span className="text-slate-200">Friends Invited</span>
            <span className="text-white font-bold text-lg">{user.referralsCount}</span>
        </div>
        <div className="flex justify-between items-center py-2">
            <span className="text-slate-200">Coins Earned</span>
            <span className="text-lime-400 font-bold text-lg">{formatNumber(user.referralsCount * 100)}</span>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <label className="text-sm text-slate-400 ml-1">Your Referral Link</label>
        <div className="flex gap-2">
            <div className="bg-slate-950 flex-1 p-3 rounded-lg border border-slate-800 text-slate-300 text-sm truncate font-mono">
                {referralLink}
            </div>
            <button 
                onClick={handleCopy}
                className="bg-lime-500 text-slate-900 font-bold px-4 rounded-lg hover:bg-lime-400 transition-colors"
            >
                Copy
            </button>
        </div>
      </div>
    </div>
  );
};

export default TeamView;
