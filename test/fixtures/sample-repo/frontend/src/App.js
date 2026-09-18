import React from 'react';
import { BrowserRouter, Route, Switch } from 'react-router-dom';
import EmailList from './components/EmailList';
import Settings from './components/Settings';

// Application shell with the router.
function App() {
  return (
    <BrowserRouter>
      <Switch>
        <Route path="/emails" component={EmailList} />
        <Route path="/settings" element={<Settings />} />
      </Switch>
    </BrowserRouter>
  );
}

export default App;
