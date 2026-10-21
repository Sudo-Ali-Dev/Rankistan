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
import DevProfile from './pages/DevProfile';
import { loginFromHash, pathForTab, tabFromPath, usernameFromPath } from './utils/route';
import { setCanonical, setSiteMeta } from './utils/meta';

// Where the site is right now (src/utils/route.js). The tab comes from the URL path. Anything
// else - `/`, a campaign landing - shows the leaderboard. A developer's own page is /username,
// and the badge link every README carries, /#username, shows the same page. On the leaderboard's
// path, `/#username` is a developer's page.
function readRoute() {
  const pathname = window.location.pathname;
  const profile = usernameFromPath(pathname);
  if (profile) return { tab: 'leaderboard', profile };
  const tab = tabFromPath(pathname) || 'leaderboard';
  return { tab, profile: tab === 'leaderboard' ? loginFromHash(window.location.hash) : null };
}

function App() {
  const [route, setRoute] = useState(readRoute);
  const [searchTerm, setSearchTerm] = useState('');
  const [badgePrefillUsername, setBadgePrefillUsername] = useState('');
  const { tab: activeTab, profile } = route;

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
    document.title = profile ? `Rankistan | ${profile}` : titles[activeTab] || 'Rankistan';
  }, [activeTab, profile]);

  // The canonical link follows the path. A developer's own page is its own address; a tab is
  // the tab's. The tags of the site itself are put back when a tab is shown, so a page that was
  // a developer's does not keep previewing them.
  React.useEffect(() => {
    if (profile) {
      setCanonical(`https://rankistan.dev/${profile}`);
      return;
    }
    setCanonical(`https://rankistan.dev${pathForTab(activeTab)}`);
    setSiteMeta();
  }, [activeTab, profile]);

  // The URL holds the tab, so a reload restores it (#32) and the back button moves between tabs.
  // Tabs go through history.pushState, which is what Cloudflare Web Analytics counts as a page view
  // in a single-page app; a hash change would not be counted.
  const goToTab = useCallback((tab) => {
    const path = pathForTab(tab);
    if (window.location.pathname !== path || window.location.hash) {
      window.history.pushState(null, '', path);
    }
    setRoute({ tab, profile: null });
  }, []);

  React.useEffect(() => {
    const onRouteChange = () => setRoute(readRoute());
    window.addEventListener('popstate', onRouteChange);
    window.addEventListener('hashchange', onRouteChange);
    return () => {
      window.removeEventListener('popstate', onRouteChange);
      window.removeEventListener('hashchange', onRouteChange);
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

  // Another developer's page, from the list of similar developers: the URL moves the way a tab
  // does, so the back button still works and the page view is counted under its own path.
  const openProfile = useCallback((login) => {
    const name = String(login || '').trim();
    if (!name) return;
    window.history.pushState(null, '', `/${name}`);
    setRoute({ tab: 'leaderboard', profile: name });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  return (
    <>
      <Header activeTab={activeTab} onChangeTab={handleChangeTab} searchTerm={searchTerm} onSearchChange={setSearchTerm} />
      <div className={`pb-[calc(4.25rem+env(safe-area-inset-bottom,0px))] ${activeTab === 'leaderboard' ? 'xl:pb-0' : 'lg:pb-0'}`}>
        {activeTab === 'leaderboard' && profile && (
          <DevProfile
            username={profile}
            onBack={() => goToTab('leaderboard')}
            onOpenProfile={openProfile}
            onBadge={handleNavigateToBadge}
          />
        )}
        {activeTab === 'leaderboard' && !profile && <Leaderboard searchTerm={searchTerm} onSearchChange={setSearchTerm} onChangeTab={handleChangeTab} onNavigateToBadge={handleNavigateToBadge} onOpenProfile={openProfile} />}
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
