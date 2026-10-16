import { createApp } from './app.js';

// Local-development default only; a host injects its own PORT.
const DEFAULT_PORT = 3000;

function readPort(): number {
  const raw = process.env.PORT;
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535, got "${raw}"`);
  }
  return port;
}

const port = readPort();

const server = createApp().listen(port, (error) => {
  if (error) throw error;
  console.log(`api listening on port ${port}`);
});

function shutdown(signal: NodeJS.Signals) {
  console.log(`api received ${signal}, closing`);
  server.close(() => console.log('api closed'));
  server.closeIdleConnections();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
