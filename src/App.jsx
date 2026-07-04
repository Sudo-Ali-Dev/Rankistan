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

function App() {
  const [activeTab, setActiveTab] = useState('leaderboard');
  const [searchTerm, setSearchTerm] = useState('');
  const [badgePrefillUsername, setBadgePrefillUsername] = useState('');
  const [highlightUsername, setHighlightUsername] = useState(() =>
    decodeURIComponent(window.location.hash.slice(1))
  );

  // React to manual hash changes in the URL bar (e.g. user types #username and hits Enter)
  React.useEffect(() => {
    function onHashChange() {
      const hash = decodeURIComponent(window.location.hash.slice(1));
      if (hash) {
        setHighlightUsername(hash);
        setActiveTab('leaderboard');
      } else {
        setHighlightUsername('');
      }
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Update dynamic page title based on active tab
  React.useEffect(() => {
    const titles = {
      leaderboard: 'Rankistan | Leaderboard',
      register: 'Rankistan | Register',
      map: 'Rankistan | Dev Map',
      about: 'Rankistan | About',
      evolution: 'Rankistan | Evolution',
      badge: 'Rankistan | Badge Generator',
    };
    document.title = titles[activeTab] || 'Rankistan';
  }, [activeTab]);

  const handleChangeTab = useCallback((tab) => {
    setActiveTab(tab);
    if (tab !== 'leaderboard') {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      setHighlightUsername('');
    }
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
      <div className="pb-[calc(4.25rem+env(safe-area-inset-bottom,0px))] md:pb-0">
        {activeTab === 'leaderboard' && <Leaderboard searchTerm={searchTerm} onSearchChange={setSearchTerm} onChangeTab={handleChangeTab} onNavigateToBadge={handleNavigateToBadge} highlightUsername={highlightUsername} onHighlightUsernameChange={setHighlightUsername} />}
        {activeTab === 'register' && <Register onChangeTab={handleChangeTab} />}
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
