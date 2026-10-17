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
import Developer from './pages/Developer';
import { loginFromHash, pathForTab, tabFromPath } from './utils/route';

// The tab comes from the URL path (src/utils/route.js). Anything else - `/`, a campaign landing -
// shows the leaderboard. On the leaderboard's path, `/#username` is a developer's page: the link
// every README badge carries.
function getInitialTab() {
  try {
    return tabFromPath(window.location.pathname) || 'leaderboard';
  } catch {
    return 'leaderboard';
  }
}

function App() {
  const [activeTab, setActiveTab] = useState(getInitialTab);
  const [developer, setDeveloper] = useState(() => loginFromHash(window.location.hash));
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
    document.title =
      activeTab === 'leaderboard' && developer
        ? `Rankistan | ${developer}`
        : titles[activeTab] || 'Rankistan';
  }, [activeTab, developer]);

  // The URL holds the tab, so a reload restores it (#32) and the back button moves between tabs.
  // Tabs go through history.pushState, which is what Cloudflare Web Analytics counts as a page view
  // in a single-page app; a hash change would not be counted.
  const goToTab = useCallback((tab) => {
    setActiveTab(tab);
    setDeveloper(null);
    const path = pathForTab(tab);
    if (window.location.pathname !== path || window.location.hash) {
      window.history.pushState(null, '', path);
    }
  }, []);

  React.useEffect(() => {
    const onPopState = () => {
      setActiveTab(tabFromPath(window.location.pathname) || 'leaderboard');
      setDeveloper(loginFromHash(window.location.hash));
    };
    window.addEventListener('popstate', onPopState);
    window.addEventListener('hashchange', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('hashchange', onPopState);
    };
  }, []);

  const handleChangeTab = useCallback((tab) => {
    goToTab(tab);
  }, [goToTab]);

  const handleNavigateToBadge = useCallback((username) => {
    setBadgePrefillUsername(String(username || '').trim());
    goToTab('badge');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [goToTab]);

  const handleBadgePrefillConsumed = useCallback(() => {
    setBadgePrefillUsername('');
  }, []);

  return (
    <>
      <Header activeTab={activeTab} onChangeTab={handleChangeTab} searchTerm={searchTerm} onSearchChange={setSearchTerm} />
      <div className={`pb-[calc(4.25rem+env(safe-area-inset-bottom,0px))] ${activeTab === 'leaderboard' ? 'xl:pb-0' : 'lg:pb-0'}`}>
        {activeTab === 'leaderboard' && developer && (
          <Developer login={developer} onBack={() => goToTab('leaderboard')} />
        )}
        {activeTab === 'leaderboard' && !developer && <Leaderboard searchTerm={searchTerm} onSearchChange={setSearchTerm} onChangeTab={handleChangeTab} onNavigateToBadge={handleNavigateToBadge} />}
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
