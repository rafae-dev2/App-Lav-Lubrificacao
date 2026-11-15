import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
// Optional V18 surface layer; keeping it last lets it override legacy tokens safely.
import './styles/glassy-v18.css';
import './styles/glassy-v18-refinements.css';
import './styles/apoio-premium.css';
import './styles/apoio-reference.css';
import './styles/apoio-devices.css';
import './styles/lavagem-premium.css';
import './styles/verdan-os.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
