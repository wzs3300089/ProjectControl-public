import { homedir } from 'node:os';
import { join } from 'node:path';

// User data is independent of Codex's versioned plugin cache.
const dataDir = process.env.PROJECT_CONTROL_DATA_DIR || join(homedir(), '.codex', 'project-control', 'data');
process.argv.push('--data', join(dataDir, 'note.sqlite'));
await import('./server.mjs');
