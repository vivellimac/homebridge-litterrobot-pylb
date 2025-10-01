/* Node core (must come first for eslint import/order)  */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';

/* External */
import {
  PlatformAccessory,
  API,
  Logging,
  PlatformConfig,
  Service,
  Characteristic,
  HAP,
  DynamicPlatformPlugin,
} from 'homebridge';

/* Internal */
import { initRootLogger } from './log';
import { PLUGIN_NAME, PLATFORM_NAME } from './settings';

/* ---------- types ---------- */

type LastSnapshot = {
  cycle: boolean;
  idle: boolean;
  code: string | null;
};

type AccessoryContext = {
  robotId: string;
  _last: LastSnapshot;
  _pulseMs: number;
};

type Status = {
  id: string;
  name: string;
  status_code: string | null;
  status_label: string | null;
  cycle: boolean;
  idle: boolean;
  pinch: boolean;
  bonnet: boolean;
  home: boolean;
  paused: boolean;
  offline: boolean;
};

/* ---------- platform ---------- */

export class LitterRobotPlatform implements DynamicPlatformPlugin {
  private readonly hap: HAP;
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly accessories = new Map<string, PlatformAccessory<AccessoryContext>>();
  private poll?: NodeJS.Timeout;
  private py: ChildProcess | null = null;
  private tailStop?: () => void;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    initRootLogger(log);
    this.hap = api.hap;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    if (!config) {
      this.log.warn('No config block provided; skipping initialization.');
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.start();
    });
    this.api.on('shutdown', () => this.stop());
  }

  configureAccessory(acc: PlatformAccessory<AccessoryContext>) {
    this.accessories.set(acc.UUID, acc);
  }

  // ---------- lifecycle ----------
  private start(): void {
    const port = Number(this.config.port ?? 8765);
    const workdir = String(this.config.workdir ?? path.join(this.api.user.storagePath(), 'lr-sidecar'));
    const debug = Boolean(this.config.debug);
    const pulseMs = clampNumber(Number(this.config.pulseMs ?? 1500), 250, 10_000);
    const pollInterval = clampNumber(Number(this.config.pollInterval ?? 5000), 3000, 60_000);
    const username = String(this.config.username ?? '');
    const password = String(this.config.password ?? '');

    if (!username || !password) {
      this.log.warn('Missing username/password in config — plugin idle.');
      return;
    }

    // Ensure workdir exists
    try {
      fs.mkdirSync(workdir, { recursive: true });
    } catch (e) {
      this.log.error(`Failed to create workdir ${workdir}: ${errMsg(e)}`);
      return;
    }

    // Always use system Python to run bootstrap; let bootstrap manage/repair the venv.
    const systemPy = String(this.config.python ?? 'python3');

    // Paths for logs only (we no longer spawn the venv python directly here)
    const venvDir = path.join(workdir, '.venv');
    const venvPy = path.join(venvDir, 'bin', 'python');

    // Sidecar bootstrap path (within our installed package)
    const pluginDir = path.resolve(this.api.user.storagePath(), 'node_modules', PLUGIN_NAME);
    const bootstrap = path.join(pluginDir, 'sidecar', 'bootstrap.py');
    const bLog = path.join(workdir, 'bootstrap.log');

    if (debug) {
      this.log.info(
        `[sidecar] workdir=${workdir} port=${port} bootstrap=${bootstrap} systemPy=${systemPy} venvPy=${venvPy}`,
      );
    }

    // Check current health. If not healthy, run bootstrap via system Python.
    // While waiting, tail the bootstrap progress log.
    this.log.info('[sidecar] Waiting for /health ...');
    this.tailStop = tailBootstrapLog(bLog, (line) => this.log.info(`[sidecar] ${line}`));

    waitForHealth(port, 4_000)
      .then((healthy) => {
        if (healthy) {
          try { this.tailStop?.(); } catch { /* ignore */ }
          this.log.info(`Sidecar healthy at http://127.0.0.1:${port}`);
          this.loginAndBegin(username, password, port, pulseMs, pollInterval, debug);
          return;
        }

        this.log.info('[sidecar] Not healthy; invoking bootstrap …');
        try {
          this.py = spawn(systemPy, [bootstrap, '--workdir', workdir, '--port', String(port)], {
            stdio: 'ignore',
            env: process.env,
          });
          this.py.on('exit', (code, signal) => {
            this.log.warn(`Sidecar exited (code=${code ?? 'n/a'} signal=${signal ?? 'n/a'})`);
          });
        } catch (e) {
          this.log.error(
            `Failed to spawn bootstrap with ${systemPy}: ${errMsg(e)} ` +
              `(hint: ensure ${systemPy} exists and is executable)`,
          );
          try { this.tailStop?.(); } catch { /* ignore */ }
          return; // do not loop if spawn failed
        }

        // Wait adaptively: keep waiting while bootstrap.log shows activity (up to 15 min)
        return waitForHealthAdaptive(port, bLog, 45_000, 900_000).then((ok2) => {
          try { this.tailStop?.(); } catch { /* ignore */ }
          if (!ok2) {
            this.log.error('Sidecar failed to start after bootstrap (no health and no recent bootstrap activity).');
            return;
          }
          // Optional sanity: venv presence for diagnostics only
          const venvOk = fs.existsSync(venvPy);
          if (debug) this.log.info(`[sidecar] venv python present: ${venvOk ? 'yes' : 'no'}`);

          this.log.info(`Sidecar healthy at http://127.0.0.1:${port}`);
          this.loginAndBegin(username, password, port, pulseMs, pollInterval, debug);
        });
      })
      .catch((e) => {
        try { this.tailStop?.(); } catch { /* ignore */ }
        this.log.error(`Health check error: ${errMsg(e)}`);
      });
  }

  private stop(): void {
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
    try { this.tailStop?.(); } catch { /* ignore */ }
    if (this.py) {
      this.py.kill();
      this.py = null;
    }
  }

  // ---------- after healthy ----------
  private loginAndBegin(
    username: string,
    password: string,
    port: number,
    pulseMs: number,
    pollInterval: number,
    debug: boolean,
  ): void {
    this.request('POST', port, '/login', (err, body) => {
      if (err) {
        this.log.error(`Login failed: ${errMsg(err)}`);
        return;
      }
      try {
        const parsed = JSON.parse(body ?? '{}') as { robots?: unknown };
        const ids = Array.isArray(parsed.robots)
          ? parsed.robots.filter((x): x is string => typeof x === 'string')
          : [];
        ids.forEach((id) => this.upsertRobot(id, pulseMs));

        if (this.poll) clearInterval(this.poll);
        this.poll = setInterval(() => this.pollOnce(port, debug, pulseMs), pollInterval);
      } catch (e) {
        this.log.error(`Login parse error: ${errMsg(e)}`);
      }
    }, { username, password });
  }

  // ---------- accessories ----------
  private upsertRobot(id: string, pulseMs: number): void {
    const uuid = this.hap.uuid.generate(id);
    let acc = this.accessories.get(uuid);

    if (!acc) {
      const newAcc = new this.api.platformAccessory<AccessoryContext>(`Litter-Robot ${id.slice(-4)}`, uuid);
      newAcc.context.robotId = id;

      const sw = newAcc.addService(this.Service.Switch, 'Cycle Now');
      sw.getCharacteristic(this.Characteristic.On).onSet((val) => {
        if (!val) return;
        this.request('POST', Number(this.config.port ?? 8765), `/cycle/${id}`, (err2) => {
          if (err2) this.log.warn(`Cycle command failed: ${errMsg(err2)}`);
          setTimeout(() => sw.updateCharacteristic(this.Characteristic.On, false), 500);
        }, {});
      });

      newAcc.addService(this.Service.ContactSensor, 'Bonnet', 'Bonnet');
      newAcc.addService(this.Service.ContactSensor, 'Pinch', 'Pinch');
      newAcc.addService(this.Service.OccupancySensor, 'Offline', 'Offline');
      newAcc.addService(this.Service.MotionSensor, 'Cycle Completed', 'CycleCompleted');
      newAcc.addService(this.Service.ContactSensor, 'Cycle Fault', 'CycleFault');

      newAcc.context._last = { cycle: false, idle: false, code: null };
      newAcc.context._pulseMs = pulseMs;

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [newAcc]);
      this.accessories.set(uuid, newAcc);
      acc = newAcc;
    }
  }

  // ---------- polling ----------
  private pollOnce(port: number, debug: boolean, pulseMs: number): void {
    for (const acc of this.accessories.values()) {
      const id = String(acc.context.robotId ?? '');
      if (!id) continue;

      this.getStatus(id, port, (st) => {
        const switchSvc = acc.getService(this.Service.Switch);
        if (switchSvc) {
          switchSvc.updateCharacteristic(this.Characteristic.On, st.cycle);
        }

        const bonnetSvc = acc.getServiceById(this.Service.ContactSensor, 'Bonnet');
        const pinchSvc = acc.getServiceById(this.Service.ContactSensor, 'Pinch');
        const offlineSvc = acc.getServiceById(this.Service.OccupancySensor, 'Offline');
        const completedSvc = acc.getServiceById(this.Service.MotionSensor, 'CycleCompleted');
        const faultSvc = acc.getServiceById(this.Service.ContactSensor, 'CycleFault');

        if (bonnetSvc) {
          bonnetSvc.updateCharacteristic(
            this.Characteristic.ContactSensorState,
            st.bonnet
              ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
              : this.Characteristic.ContactSensorState.CONTACT_DETECTED,
          );
        }
        if (pinchSvc) {
          pinchSvc.updateCharacteristic(
            this.Characteristic.ContactSensorState,
            st.pinch
              ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
              : this.Characteristic.ContactSensorState.CONTACT_DETECTED,
          );
        }
        if (offlineSvc) {
          offlineSvc.updateCharacteristic(
            this.Characteristic.OccupancyDetected,
            st.offline
              ? this.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
              : this.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
          );
        }

        const isFault = Boolean(st.pinch || st.bonnet || st.paused || st.offline);
        if (faultSvc) {
          faultSvc.updateCharacteristic(
            this.Characteristic.ContactSensorState,
            isFault
              ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
              : this.Characteristic.ContactSensorState.CONTACT_DETECTED,
          );
        }

        const last = acc.context._last ?? { cycle: false, idle: false, code: null };
        if (last.cycle && !st.cycle && st.idle && completedSvc) {
          const ms = Number(acc.context._pulseMs ?? pulseMs);
          completedSvc.updateCharacteristic(this.Characteristic.MotionDetected, true);
          setTimeout(() => completedSvc.updateCharacteristic(this.Characteristic.MotionDetected, false), ms);
        }

        acc.context._last = { cycle: st.cycle, idle: st.idle, code: st.status_code };

        if (debug) {
          const code = st.status_code ?? 'n/a';
          const label = st.status_label ? `(${st.status_label})` : '';
          this.log.info(
            `status: code=${code}${label} cycle=${st.cycle} idle=${st.idle} pinch=${st.pinch} ` +
              `bonnet=${st.bonnet} home=${st.home} paused=${st.paused} offline=${st.offline}`,
          );
        }
      });
    }
  }

  private getStatus(id: string, port: number, cb: (s: Status) => void): void {
    this.request('GET', port, `/status/${id}`, (err, body) => {
      if (err) {
        const maybeDebug = (this.log as unknown as { debug?: (...a: unknown[]) => void }).debug;
        if (typeof maybeDebug === 'function') {
          maybeDebug(`status error ${errMsg(err)}`);
        }
        return;
      }
      try {
        const p = JSON.parse(body ?? '{}') as Partial<Status> & { id?: unknown };

        if (typeof p.id !== 'string') return;

        const s: Status = {
          id: p.id,
          name: typeof p.name === 'string' ? p.name : p.id,
          status_code: typeof p.status_code === 'string' || p.status_code === null ? p.status_code : null,
          status_label: typeof p.status_label === 'string' || p.status_label === null ? p.status_label : null,
          cycle: Boolean(p.cycle),
          idle: Boolean(p.idle),
          pinch: Boolean(p.pinch),
          bonnet: Boolean(p.bonnet),
          home: Boolean(p.home),
          paused: Boolean(p.paused),
          offline: Boolean(p.offline),
        };
        cb(s);
      } catch {
        // swallow parse errors to avoid log spam
      }
    });
  }

  // ---------- http helper ----------
  private request(
    method: 'GET' | 'POST',
    port: number,
    pathName: string,
    cb: (err: Error | null, body?: string) => void,
    data?: unknown,
  ): void {
    const payload = data != null ? Buffer.from(JSON.stringify(data)) : undefined;

    const options: http.RequestOptions = {
      host: '127.0.0.1',
      port,
      path: pathName,
      method,
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
        : undefined,
      timeout: 8000,
    };

    const req: http.ClientRequest = http.request(options, (res: http.IncomingMessage) => {
      let out = '';
      res.on('data', (c: Buffer | string) => {
        out += c.toString();
      });
      res.on('end', () => cb(null, out));
    });

    req.on('error', (e: Error) => cb(e));
    if (payload) req.write(payload);
    req.end();
  }
}

/* ---------- small helpers ---------- */

async function waitForHealthAdaptive(
  port: number,
  logFile: string,
  idleGraceMs = 45_000,   // how long to tolerate no new log lines
  maxTotalMs = 900_000,   // absolute cap (15 min)
): Promise<boolean> {
  const started = Date.now();
  let lastActivity = started;
  let lastSize = -1;

  while (Date.now() - started < maxTotalMs) {
    // Success path first
    const ok = await pingHealth(port).catch(() => false);
    if (ok) return true;

    // Track activity in bootstrap.log (if present)
    try {
      const stat = await fsp.stat(logFile);
      const size = stat.size;
      if (size !== lastSize) {
        lastSize = size;
        lastActivity = Date.now();
      } else if (Date.now() - stat.mtimeMs < 2_000) {
        // mtime changed recently; count as activity
        lastActivity = Date.now();
      }
    } catch {
      /* file may not exist yet */
    }

    // If idle beyond grace after the first minute, give up
    if ((Date.now() - started) > 60_000 && (Date.now() - lastActivity) > idleGraceMs) {
      return false;
    }

    await delay(500);
  }

  return false;
}

function clampNumber(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await pingHealth(port).catch(() => false);
    if (ok) return true;
    await delay(300);
  }
  return false;
}

function pingHealth(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 2000 },
      (res) => {
        const ok = res.statusCode === 200;
        res.resume(); // drain
        resolve(ok);
      },
    );
    req.on('error', () => resolve(false));
    req.end();
  });
}

function tailBootstrapLog(file: string, sink: (line: string) => void): () => void {
  let stopped = false;
  let position = 0;
  let watcher: fs.FSWatcher | null = null;

  // prevent overlapping reads (fs.watch + poll can fire together)
  let inFlight = false;
  let pending = false;

  // simple de-dup: ignore the same line repeated within 2s
  let lastLine = '';
  let lastAt = 0;

  const emit = (ln: string) => {
    const now = Date.now();
    if (ln === lastLine && (now - lastAt) < 2000) return;
    lastLine = ln;
    lastAt = now;
    sink(ln);
  };

  const readNew = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) { pending = true; return; }
    inFlight = true;
    try {
      const h = await fsp.open(file, 'r');
      try {
        const stat = await h.stat();
        // handle truncation or recreate
        if (stat.size < position) position = 0;

        if (stat.size > position) {
          const count = stat.size - position;
          const buf = Buffer.allocUnsafe(count);
          await h.read(buf, 0, count, position);
          position = stat.size;

          const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
          for (const ln of lines) emit(ln);
        }
      } finally {
        await h.close();
      }
    } catch {
      // file may not exist yet; ignore
    } finally {
      inFlight = false;
      if (pending) {
        pending = false;
        setTimeout(() => { void readNew(); }, 25);
      }
    }
  };

  // initial read & poll fallback
  void readNew();
  const timer = setInterval(() => { if (!stopped) void readNew(); }, 1000);

  try {
    watcher = fs.watch(path.dirname(file), (_evt, fname) => {
      if (stopped) return;
      if (!fname) return;
      const full = path.join(path.dirname(file), fname);
      if (full === file) void readNew();
    });
  } catch {
    // fs.watch may not be available; polling covers us
  }

  return () => {
    stopped = true;
    clearInterval(timer);
    try { watcher?.close(); } catch { /* ignore */ }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
