import { formatTime } from './util/time';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('#app not found');

app.innerHTML = `
  <header>
    <h1>Song Looper</h1>
    <p>Drop a song, find loops that repeat cleanly, and export an extended version.</p>
  </header>
  <p class="muted">Ready. Empty song length: ${formatTime(0)}</p>
`;
