#!/usr/bin/env node
// Startet Demo-API und Dashboard zusammen: npm run demo → http://localhost:8080
process.env.FIREFLY_URL = `http://localhost:${process.env.MOCK_PORT || 8090}`;
process.env.FIREFLY_TOKEN = 'demo';
process.env.FIREFLY_PUBLIC_URL = '';
await import('./firefly-mock.js');
await import('../server.js');
