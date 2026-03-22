import React, { useState } from 'react';
import Header from './components/Header';
import Footer from './components/Footer';
import Leaderboard from './pages/Leaderboard';
import Register from './pages/Register';
import WeeklyDigest from './pages/WeeklyDigest';

function App() {
  const [activeTab, setActiveTab] = useState('leaderboard');

  return (
    <>
      <Header activeTab={activeTab} onChangeTab={setActiveTab} />
      {activeTab === 'leaderboard' && <Leaderboard />}
      {activeTab === 'register' && <Register />}
      {activeTab === 'weekly_digest' && <WeeklyDigest />}
      <Footer />
    </>
  );
}

export default App;
