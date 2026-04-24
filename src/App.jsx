import React, { useState, useCallback } from 'react';
import Header from './components/Header';
import MobileTabBar from './components/MobileTabBar';
import Footer from './components/Footer';
import Leaderboard from './pages/Leaderboard';
import Register from './pages/Register';
import DevMap from './pages/DevMap';
import About from './pages/About';

function App() {
  const [activeTab, setActiveTab] = useState('leaderboard');
  const [searchTerm, setSearchTerm] = useState('');

  const handleChangeTab = useCallback((tab) => {
    setActiveTab(tab);
  }, []);

  return (
    <>
      <Header activeTab={activeTab} onChangeTab={handleChangeTab} searchTerm={searchTerm} onSearchChange={setSearchTerm} />
      <div className="pb-[calc(4.25rem+env(safe-area-inset-bottom,0px))] md:pb-0">
        {activeTab === 'leaderboard' && <Leaderboard searchTerm={searchTerm} />}
        {activeTab === 'register' && <Register onChangeTab={handleChangeTab} />}
        {activeTab === 'map' && <DevMap />}
        {activeTab === 'about' && <About />}
        <Footer />
      </div>
      <MobileTabBar activeTab={activeTab} onChangeTab={handleChangeTab} />
    </>
  );
}

export default App;
