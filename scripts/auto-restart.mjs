// Detached helper: survives DSH's normal quit and relaunches it with debugging.
import { performRestart } from '../src/restart.js';
await performRestart(JSON.parse(process.argv[2]));
