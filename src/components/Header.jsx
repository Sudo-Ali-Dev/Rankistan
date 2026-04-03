import React, { useState } from 'react';

export default function Header({ activeTab, onChangeTab, searchTerm, onSearchChange }) {
  const [showNotif, setShowNotif] = useState(false);

  return (
    <nav className="bg-[#10141a] border-b border-[#414752] flex justify-between items-center w-full px-6 h-16 sticky top-0 z-50">
      <div className="flex items-center gap-8">
        <button 
          onClick={() => onChangeTab('leaderboard')} 
          className="text-xl font-bold tracking-tighter text-[#a2c9ff] uppercase font-['Space_Grotesk'] hover:opacity-80 transition-opacity"
        >
          Rankistan
        </button>
        <div className="hidden md:flex gap-6 font-['Space_Grotesk'] tracking-tight">
          <button 
            onClick={() => onChangeTab('leaderboard')}
            className={`${activeTab === 'leaderboard' ? 'text-[#a2c9ff] border-b-2 border-[#a2c9ff] pb-1' : 'text-[#8b919d] hover:text-[#a2c9ff]'} transition-colors duration-50`}
          >
            Leaderboard
          </button>
          <button 
            onClick={() => onChangeTab('map')}
            className={`${activeTab === 'map' ? 'text-[#a2c9ff] border-b-2 border-[#a2c9ff] pb-1' : 'text-[#8b919d] hover:text-[#a2c9ff]'} transition-colors duration-50`}
          >
            Map
          </button>
          <button 
            onClick={() => onChangeTab('register')}
            className={`${activeTab === 'register' ? 'text-[#a2c9ff] border-b-2 border-[#a2c9ff] pb-1' : 'text-[#8b919d] hover:text-[#a2c9ff]'} transition-colors duration-50`}
          >
            Register
          </button>
          <button 
            onClick={() => onChangeTab('about')}
            className={`${activeTab === 'about' ? 'text-[#a2c9ff] border-b-2 border-[#a2c9ff] pb-1' : 'text-[#8b919d] hover:text-[#a2c9ff]'} transition-colors duration-50`}
          >
            About
          </button>
        </div>
      </div>
      <div className="flex items-center gap-4">
        {activeTab === 'leaderboard' && (
          <div className="relative hidden lg:block mr-2">
            <input className="bg-surface-container-lowest border-b-2 border-outline-variant focus:border-tertiary focus:ring-0 text-sm font-mono py-1 px-3 w-64 placeholder:text-outline/50 transition-all text-on-surface" placeholder="Search developer..." type="text" value={searchTerm} onChange={(e) => onSearchChange(e.target.value)} />
            <span className="material-symbols-outlined absolute right-2 top-1 text-outline">search</span>
          </div>
        )}
        <div className="relative">
          <button onClick={() => setShowNotif((v) => !v)} className="p-2 text-[#8b919d] hover:bg-[#262a31] transition-colors duration-50 active:scale-95">
            <span className="material-symbols-outlined">notifications</span>
          </button>
          {showNotif && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowNotif(false)} />
              <div className="absolute right-0 top-12 z-50 w-72 bg-[#1a1f27] border border-[#414752] shadow-xl p-5 font-mono text-xs text-[#8b919d]">
                <div className="flex items-center gap-2 text-[#a2c9ff] mb-3 uppercase tracking-widest text-[10px] font-bold">
                  <span className="material-symbols-outlined text-sm">construction</span>
                  Under Construction
                </div>
                <p className="leading-relaxed">Notifications aren't wired up yet. We're too busy ranking developers to build a bell that rings.</p>
                <p className="mt-2 text-[#414752]">// TODO: make this do something</p>
              </div>
            </>
          )}
        </div>
        <a href="https://sudo-ali-dev.github.io/" target="_blank" rel="noopener noreferrer" className="p-2 text-[#8b919d] hover:bg-[#262a31] transition-colors duration-50 active:scale-95">
          <span className="material-symbols-outlined">terminal</span>
        </a>
        <a href="https://github.com/Sudo-Ali-Dev/pakdev-index" target="_blank" rel="noopener noreferrer" className="w-8 h-8 flex items-center justify-center text-[#8b919d] hover:text-white transition-colors">
          <svg viewBox="0 0 16 16" width="24" height="24" fill="currentColor" aria-label="GitHub">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
        </a>
      </div>
    </nav>
  );
}
