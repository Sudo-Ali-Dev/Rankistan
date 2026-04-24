import React, { useState, useEffect } from 'react';

export default function Header({ activeTab, onChangeTab, searchTerm, onSearchChange }) {
  const [showNotif, setShowNotif] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const go = (tab) => {
    onChangeTab(tab);
    setMenuOpen(false);
    setShowNotif(false);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <nav className="relative bg-[#10141a] border-b border-[#414752] w-full h-16 sticky top-0 z-50">
      <div className="relative z-20 flex h-16 w-full min-w-0 items-center justify-between px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-4 md:gap-8">
        <button 
          type="button"
          onClick={() => go('leaderboard')} 
          aria-label="Rankistan"
          className="flex shrink-0 items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <img
            src="/favicon.svg"
            alt="Rankistan logo"
            className="w-9 h-9 object-contain"
          />
          <span
            className="text-[#a2c9ff] text-[1.7rem] md:text-[2rem] leading-none"
            style={{ fontFamily: "'Waltograph', 'Space Grotesk', sans-serif" }}
          >
            Rankistan
          </span>
        </button>
        <div className="hidden md:flex gap-6 font-['Space_Grotesk'] tracking-tight">
          <button 
            type="button"
            onClick={() => go('leaderboard')}
            className={`${activeTab === 'leaderboard' ? 'text-[#a2c9ff] border-b-2 border-[#a2c9ff] pb-1' : 'text-[#8b919d] hover:text-[#a2c9ff]'} transition-colors duration-50`}
          >
            Leaderboard
          </button>
          <button 
            type="button"
            onClick={() => go('map')}
            className={`${activeTab === 'map' ? 'text-[#a2c9ff] border-b-2 border-[#a2c9ff] pb-1' : 'text-[#8b919d] hover:text-[#a2c9ff]'} transition-colors duration-50`}
          >
            Map
          </button>
          <button 
            type="button"
            onClick={() => go('register')}
            className={`${activeTab === 'register' ? 'text-[#a2c9ff] border-b-2 border-[#a2c9ff] pb-1' : 'text-[#8b919d] hover:text-[#a2c9ff]'} transition-colors duration-50`}
          >
            Register
          </button>
          <button 
            type="button"
            onClick={() => go('about')}
            className={`${activeTab === 'about' ? 'text-[#a2c9ff] border-b-2 border-[#a2c9ff] pb-1' : 'text-[#8b919d] hover:text-[#a2c9ff]'} transition-colors duration-50`}
          >
            About
          </button>
        </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-4">
        {activeTab === 'leaderboard' && (
          <div className="relative hidden lg:block mr-2">
            <input className="bg-surface-container-lowest border-b-2 border-outline-variant focus:border-tertiary focus:ring-0 text-sm font-mono py-1 px-3 w-64 placeholder:text-outline/50 transition-all text-on-surface" placeholder="Search developer..." type="text" value={searchTerm} onChange={(e) => onSearchChange(e.target.value)} />
            <span className="material-symbols-outlined absolute right-2 top-1 text-outline">search</span>
          </div>
        )}
        <div className="relative">
          <button type="button" onClick={() => { setShowNotif((v) => !v); setMenuOpen(false); }} className="p-2 text-[#8b919d] hover:bg-[#262a31] transition-colors duration-50 active:scale-95">
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
        <button
          type="button"
          className="md:hidden p-2 text-[#8b919d] hover:bg-[#262a31] transition-colors duration-50 active:scale-95"
          onClick={() => {
            setMenuOpen((o) => !o);
            setShowNotif(false);
          }}
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
        >
          <span className="material-symbols-outlined">{menuOpen ? 'close' : 'menu'}</span>
        </button>
        </div>
      </div>

      {menuOpen && (
        <>
          <div
            className="fixed inset-0 z-10 bg-black/50 md:hidden"
            aria-hidden
            onClick={() => setMenuOpen(false)}
          />
          <div
            id="mobile-nav"
            className="absolute left-0 right-0 top-full z-20 border-b border-[#414752] bg-[#10141a] shadow-2xl md:hidden max-h-[min(70vh,calc(100dvh-4rem))] overflow-y-auto"
            role="navigation"
            aria-label="Main"
          >
            <div className="flex flex-col px-4 py-3 font-['Space_Grotesk'] tracking-tight">
              <button
                type="button"
                onClick={() => go('leaderboard')}
                className={`text-left w-full py-3 px-1 border-b border-[#2a2f3a] text-base ${activeTab === 'leaderboard' ? 'text-[#a2c9ff] font-medium' : 'text-[#8b919d] active:bg-[#262a31]'}`}
              >
                Leaderboard
              </button>
              <button
                type="button"
                onClick={() => go('map')}
                className={`text-left w-full py-3 px-1 border-b border-[#2a2f3a] text-base ${activeTab === 'map' ? 'text-[#a2c9ff] font-medium' : 'text-[#8b919d] active:bg-[#262a31]'}`}
              >
                Map
              </button>
              <button
                type="button"
                onClick={() => go('register')}
                className={`text-left w-full py-3 px-1 border-b border-[#2a2f3a] text-base ${activeTab === 'register' ? 'text-[#a2c9ff] font-medium' : 'text-[#8b919d] active:bg-[#262a31]'}`}
              >
                Register
              </button>
              <button
                type="button"
                onClick={() => go('about')}
                className={`text-left w-full py-3 px-1 text-base ${activeTab === 'about' ? 'text-[#a2c9ff] font-medium' : 'text-[#8b919d] active:bg-[#262a31]'}`}
              >
                About
              </button>
            </div>
          </div>
        </>
      )}
    </nav>
  );
}
