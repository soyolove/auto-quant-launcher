import { createRoot } from 'react-dom/client';

import { App } from './App';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element');

// NOTE: StrictMode intentionally off — it double-mounts useEffect in dev,
// which causes our PTY-attaching WS to be opened + immediately closed +
// reopened. The second open then "kicks" the first via the server's
// new-attach-kicks-old code (4001), and that 4001 close handler fires on
// the same React instance, leaving status stuck at "kicked" even though
// the current WS is actually fine. The proper fix is to make the
// attach/detach handlers ref-based so stale-WS close events don't
// overwrite live state, which is M-future work; off for now.
createRoot(rootEl).render(<App />);
