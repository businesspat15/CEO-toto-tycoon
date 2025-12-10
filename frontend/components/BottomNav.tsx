import React from 'react';
import { Tab } from '../types';
import { IconPickaxe, IconTrophy, IconBuilding, IconBox, IconUsers } from './Icons';

interface BottomNavProps {
  currentTab: Tab;
  onTabChange: (tab: Tab) => void;
}

const BottomNav: React.FC<BottomNavProps> = ({ currentTab, onTabChange }) => {
  const navItems = [
    { id: Tab.MINE, label: 'Mine', icon: IconPickaxe },
    { id: Tab.LEADERBOARD, label: 'Leaderboard', icon: IconTrophy },
    { id: Tab.UPGRADE, label: 'Asset', icon: IconBuilding },
    { id: Tab.TEAM, label: 'Team', icon: IconUsers },
    { id: Tab.ME, label: 'Me', icon: IconBox },
  ];

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-slate-900 border-t border-slate-800 pb-safe z-50">
      <div className="flex justify-around items-center h-16">
        {navItems.map((item) => {
          const isActive = currentTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={`flex flex-col items-center justify-center w-full h-full transition-colors duration-200 ${
                isActive ? 'text-lime-400' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <item.icon className={`w-6 h-6 mb-1 ${isActive ? 'fill-lime-400/10' : ''}`} />
              <span className="text-[10px] font-medium tracking-wide">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default BottomNav;