import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Test helpers for the recovery tests (issue #39): a DISPOSABLE Valkey on 127.0.0.1 and a TCP proxy that can cut the
// connection in front of it. Destructive tests never touch the shared Aiven instance (jobs.md). Nothing here reads
// VALKEY_URL; every address is built from a local port.

/** The binary to start. Homebrew installs `valkey-server`; `LOCAL_VALKEY_BIN` points elsewhere (it may not be on PATH). */
export const VALKEY_BIN = process.env.LOCAL_VALKEY_BIN ?? 'valkey-server';

/** True when the binary can be run, so a machine without Valkey skips these tests with a reason instead of failing. */
export async function localValkeyAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(VALKEY_BIN, ['--version'], { stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
}

export interface LocalValkey {
  readonly port: number;
  /** Kill the server (SIGKILL: no goodbye, like a power-off). Its data is gone; nothing is persisted. */
  stop(): Promise<void>;
  /** Start it again on the same port. */
  start(): Promise<void>;
  /** Stop it for good and remove its temporary directory. */
  dispose(): Promise<void>;
}

export async function startLocalValkey(): Promise<LocalValkey> {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), 'rota-valkey-test-'));
  let child: ChildProcess | null = null;

  const start = async () => {
    // --save "" and --appendonly no: nothing is written to disk. The default policy is noeviction, as on Aiven.
    child = spawn(VALKEY_BIN, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--dir', dir], {
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      if (await canConnect(port)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the local Valkey did not start');
  };
  const stop = async () => {
    const c = child;
    child = null;
    if (!c || c.exitCode !== null) return;
    c.kill('SIGKILL');
    await new Promise((r) => c.once('exit', r));
  };

  await start();
  return {
    port,
    start,
    stop,
    async dispose() {
      await stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Pair = { dead: boolean; client: net.Socket; upstream: net.Socket };

export interface CuttableProxy {
  readonly port: number;
  /** redis:// URL of the proxy, for the client under test. */
  readonly url: string;
  /**
   * A silent outage. Every open connection, and any opened while it lasts, swallows traffic in both directions and stays open:
   * the half-open connection a sleeping laptop or a forgetful NAT leaves behind. No close, no error reaches the client.
   */
  halfOpen(): void;
  /** The network is back. New connections work again; connections that went half-open stay dead, as in real life. */
  restore(): void;
  /** A clean drop: every connection is destroyed, so both ends see it close (a reset, a server restart). */
  cut(): void;
  close(): Promise<void>;
}

export async function startCuttableProxy(targetPort: number): Promise<CuttableProxy> {
  let blackhole = false;
  const pairs = new Set<Pair>();
  const server = net.createServer((client) => {
    const pair: Pair = { dead: blackhole, client, upstream: net.connect(targetPort, '127.0.0.1') };
    pairs.add(pair);
    client.on('data', (d) => !pair.dead && pair.upstream.write(d));
    pair.upstream.on('data', (d) => !pair.dead && client.write(d));
    for (const s of [client, pair.upstream]) s.on('error', () => {});
    client.on('close', () => (pair.upstream.destroy(), pairs.delete(pair)));
    pair.upstream.on('close', () => (client.destroy(), pairs.delete(pair)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    url: `redis://127.0.0.1:${port}`,
    halfOpen() {
      blackhole = true;
      for (const p of pairs) p.dead = true;
    },
    restore() {
      blackhole = false;
    },
    cut() {
      for (const p of pairs) (p.client.destroy(), p.upstream.destroy());
    },
    async close() {
      for (const p of pairs) (p.client.destroy(), p.upstream.destroy());
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
