import React from 'react';

export default function Header({ activeTab, onChangeTab }) {
  return (
    <nav className="bg-[#10141a] border-b border-[#414752] flex justify-between items-center w-full px-6 h-16 sticky top-0 z-50">
      <div className="flex items-center gap-8">
        <button 
          onClick={() => onChangeTab('leaderboard')} 
          className="text-xl font-bold tracking-tighter text-[#a2c9ff] uppercase font-['Space_Grotesk'] hover:opacity-80 transition-opacity"
        >
          PakDev Index
        </button>
        <div className="hidden md:flex gap-6 font-['Space_Grotesk'] tracking-tight">
          <button 
            onClick={() => onChangeTab('leaderboard')}
            className={`${activeTab === 'leaderboard' ? 'text-[#a2c9ff] border-b-2 border-[#a2c9ff] pb-1' : 'text-[#8b919d] hover:text-[#a2c9ff]'} transition-colors duration-50`}
          >
            Leaderboard
          </button>
          <button 
            onClick={() => onChangeTab('weekly_digest')}
            className={`${activeTab === 'weekly_digest' ? 'text-[#a2c9ff] border-b-2 border-[#a2c9ff] pb-1' : 'text-[#8b919d] hover:text-[#a2c9ff]'} transition-colors duration-50`}
          >
            Weekly Digest
          </button>
          <button 
            onClick={() => onChangeTab('register')}
            className={`${activeTab === 'register' ? 'text-[#a2c9ff] border-b-2 border-[#a2c9ff] pb-1' : 'text-[#8b919d] hover:text-[#a2c9ff]'} transition-colors duration-50`}
          >
            Register
          </button>
        </div>
      </div>
      <div className="flex items-center gap-4">
        {activeTab === 'leaderboard' && (
          <div className="relative hidden lg:block mr-2">
            <input className="bg-surface-container-lowest border-b-2 border-outline-variant focus:border-tertiary focus:ring-0 text-sm font-mono py-1 px-3 w-64 placeholder:text-outline/50 transition-all text-on-surface" placeholder="Search developer..." type="text"/>
            <span className="material-symbols-outlined absolute right-2 top-1 text-outline">search</span>
          </div>
        )}
        <button className="p-2 text-[#8b919d] hover:bg-[#262a31] transition-colors duration-50 active:scale-95">
          <span className="material-symbols-outlined">notifications</span>
        </button>
        <button className="p-2 text-[#8b919d] hover:bg-[#262a31] transition-colors duration-50 active:scale-95">
          <span className="material-symbols-outlined">terminal</span>
        </button>
        <div className="w-8 h-8 bg-surface-container-highest border border-outline-variant overflow-hidden cursor-pointer">
          <img alt="User Developer Profile" className="w-full h-full object-cover grayscale hover:grayscale-0 transition-all" src="https://lh3.googleusercontent.com/aida-public/AB6AXuC1qr5a3k8SYdwoy4lBUsTK8GJvk5rtr2zCpTdpQB0aRgTlnMlobFBZW3RGBqSZGqBV2w2Tg7hsKWCmvp14a1pqZpt3zwCqTRyqiFVBKlRtLAJe6H5enVwpBmitIupOtfqXyZV-Q_amngmDJy75_falE1zvEChV1vxLBwItRqnWPJvGjlA4De1odzGCWO0og13xytO6d8cvmk9BdLr4ftYZnNcpi3zOOfLewCzClDQp6zQT32JJUobsjvmH9DJXRVT4jBTFdzoRAZ2Q"/>
        </div>
      </div>
    </nav>
  );
}
