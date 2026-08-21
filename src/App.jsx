import React, { useState, useCallback } from 'react';
import Header from './components/Header';
import MobileTabBar from './components/MobileTabBar';
import Footer from './components/Footer';
import Leaderboard from './pages/Leaderboard';
import DevMap from './pages/DevMap';
import About from './pages/About';
import Evolution from './pages/Evolution';
import BadgeGenerator from './pages/BadgeGenerator';
import Register from './pages/Register';
import Digest from './pages/Digest';

const VALID_TABS = ['leaderboard', 'register', 'digest', 'map', 'about', 'evolution', 'badge'];
const TAB_STORAGE_KEY = 'rankistan_active_tab';

function getInitialTab() {
  try {
    // A deep-link hash (e.g. #username from a shared or badge link) should land on
    // the leaderboard, so it takes precedence over any persisted tab.
    if (window.location.hash.slice(1)) return 'leaderboard';
    const saved = localStorage.getItem(TAB_STORAGE_KEY);
    if (saved && VALID_TABS.includes(saved)) return saved;
  } catch { /* ignore storage/access errors */ }
  return 'leaderboard';
}

function App() {
  const [activeTab, setActiveTab] = useState(getInitialTab);
  const [searchTerm, setSearchTerm] = useState('');
  const [badgePrefillUsername, setBadgePrefillUsername] = useState('');

  // Update dynamic page title based on active tab
  React.useEffect(() => {
    const titles = {
      leaderboard: 'Rankistan | Leaderboard',
      register: 'Rankistan | Register',
      digest: 'Rankistan | Repository Digest',
      map: 'Rankistan | Dev Map',
      about: 'Rankistan | About',
      evolution: 'Rankistan | Evolution',
      badge: 'Rankistan | Badge Generator',
    };
    document.title = titles[activeTab] || 'Rankistan';
  }, [activeTab]);

  // Persist the active tab so a page reload restores it (#32)
  React.useEffect(() => {
    try { localStorage.setItem(TAB_STORAGE_KEY, activeTab); } catch { /* ignore */ }
  }, [activeTab]);

  const handleChangeTab = useCallback((tab) => {
    setActiveTab(tab);
  }, []);

  const handleNavigateToBadge = useCallback((username) => {
    setBadgePrefillUsername(String(username || '').trim());
    setActiveTab('badge');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const handleBadgePrefillConsumed = useCallback(() => {
    setBadgePrefillUsername('');
  }, []);

  return (
    <>
      <Header activeTab={activeTab} onChangeTab={handleChangeTab} searchTerm={searchTerm} onSearchChange={setSearchTerm} />
      <div className={`pb-[calc(4.25rem+env(safe-area-inset-bottom,0px))] ${activeTab === 'leaderboard' ? 'xl:pb-0' : 'lg:pb-0'}`}>
        {activeTab === 'leaderboard' && <Leaderboard searchTerm={searchTerm} onSearchChange={setSearchTerm} onChangeTab={handleChangeTab} onNavigateToBadge={handleNavigateToBadge} />}
        {activeTab === 'register' && <Register onChangeTab={handleChangeTab} />}
        {activeTab === 'digest' && <Digest onChangeTab={handleChangeTab} />}
        {activeTab === 'map' && <DevMap />}
        {activeTab === 'about' && <About onChangeTab={handleChangeTab} />}
        {activeTab === 'evolution' && <Evolution />}
        {activeTab === 'badge' && (
          <BadgeGenerator
            initialUsername={badgePrefillUsername}
            onInitialUsernameConsumed={handleBadgePrefillConsumed}
          />
        )}
        <Footer />
      </div>
      <MobileTabBar activeTab={activeTab} onChangeTab={handleChangeTab} />
    </>
  );
}

export default App;
