import React, { useState, useCallback } from 'react';
import Header from './components/Header';
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
      {activeTab === 'leaderboard' && <Leaderboard searchTerm={searchTerm} />}
      {activeTab === 'register' && <Register onChangeTab={handleChangeTab} />}
      {activeTab === 'map' && <DevMap />}
      {activeTab === 'about' && <About />}
      <Footer />
    </>
  );
}

export default App;
