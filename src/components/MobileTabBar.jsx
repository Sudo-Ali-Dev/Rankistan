import React from 'react';

const TABS = [
  { id: 'leaderboard', label: 'Board', icon: 'leaderboard' },
  { id: 'map', label: 'Map', icon: 'map' },
  { id: 'register', label: 'Join', icon: 'app_registration' },
  { id: 'about', label: 'About', icon: 'info' },
];

export default function MobileTabBar({ activeTab, onChangeTab }) {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 flex items-stretch justify-around gap-0 border-t border-[#414752] bg-[#10141a] px-1 pt-1.5 shadow-[0_-4px_24px_rgba(0,0,0,0.35)] md:hidden"
      style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
      aria-label="Main navigation"
    >
      {TABS.map(({ id, label, icon }) => {
        const isActive = activeTab === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChangeTab(id)}
            className={`flex min-h-[3rem] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 transition-colors active:scale-95 ${
              isActive
                ? 'text-[#a2c9ff]'
                : 'text-[#8b919d] active:bg-[#262a31]'
            }`}
            aria-current={isActive ? 'page' : undefined}
          >
            <span className="material-symbols-outlined text-[1.4rem] leading-none">{icon}</span>
            <span className="max-w-full truncate text-center font-['Space_Grotesk'] text-[0.6rem] font-medium uppercase tracking-tight">
              {label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
