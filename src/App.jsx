import React, { useState, useCallback } from 'react';
import Header from './components/Header';
import Footer from './components/Footer';
import Leaderboard from './pages/Leaderboard';
import Register from './pages/Register';

function App() {
  const [activeTab, setActiveTab] = useState('leaderboard');
  const handleChangeTab = useCallback((tab) => {
    setActiveTab(tab);
  }, []);

  return (
    <>
      <Header activeTab={activeTab} onChangeTab={handleChangeTab} />
      {activeTab === 'leaderboard' && <Leaderboard />}
      {activeTab === 'register' && <Register />}
      <Footer />
    </>
  );
}

export default App;
