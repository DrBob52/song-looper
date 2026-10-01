import './style.css';
import './skins/pro.css';
import './skins/studio.css';
import './skins/club.css';
import './skins/space.css';
import { App } from './app';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('#app not found');
const app = new App(root);
// Handy for debugging and end-to-end tests.
(window as unknown as { songLooper: App }).songLooper = app;
