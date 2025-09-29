import { PlatformAccessory, API, Logging, PlatformConfig, Service, Characteristic, HAP, DynamicPlatformPlugin } from 'homebridge';

import { PLUGIN_NAME, PLATFORM_NAME } from './settings';
import { initRootLogger } from './log';

/* Node core imports (order matters for eslint import/order) */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';

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

export class LitterRobotPlatform implements DynamicPlatformPlugin {
  private readonly hap: HAP;
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly accessories = new Map<string, PlatformAccessory>();
  private poll?: NodeJS.Timeout;
  private py: ChildProcess | null = null;

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

    this.api.on('didFinishLaunching', () => this.start());
    this.api.on('shutdown', () => this.stop());
  }

  configureAccessory(acc: PlatformAccessory) {
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

    // Determine Python executable for first run (bootstrap will create venv if missing)
    const venvPy = path.join(workdir, '.venv', 'bin', 'python');
    const pyExec = fs.existsSync(venvPy)
      ? venvPy
      : String(this.config.python ?? 'python3');

    // Sidecar bootstrap path (within our installed package)
    const pluginDir = path.resolve(
      this.api.user.storagePath(),
      'node_modules',
      PLUGIN_NAME,
    );
    const bootstrap = path.join(pluginDir, 'sidecar', 'bootstrap.py');

    // Block until healthy (bootstrap will be spawned if not healthy)
    waitForHealth(port, 4_000).then((healthy) => {
      if (healthy) {
        this.log.info(`Sidecar healthy at http://127.0.0.1:${port}`);
        this.loginAndBegin(username, password, port, pulseMs, pollInterval, debug);
        return;
      }

      // Not healthy yet → try to spawn bootstrap once
      try {
        this.py = spawn(pyExec, [bootstrap, '--workdir', workdir, '--port', String(port)], {
          stdio: 'ignore',
          env: process.env,
        });
      } catch (e) {
        this.log.error(`Failed to spawn sidecar: ${errMsg(e)}`);
      }

      this.log.info('Waiting for sidecar health...');
      waitForHealth(port, 12_000).then((ok2) => {
        if (!ok2) {
          this.log.error('Sidecar failed to start.');
          return;
        }
        this.log.info(`Sidecar healthy at http://127.0.0.1:${port}`);
        this.loginAndBegin(username, password, port, pulseMs, pollInterval, debug);
      });
    }).catch((e) => {
      this.log.error(`Health check error: ${errMsg(e)}`);
    });
  }

  private stop(): void {
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
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
    this.request('POST', port, '/login', { username, password }, (err, body) => {
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
    });
  }

  // ---------- accessories ----------
  private upsertRobot(id: string, pulseMs: number): void {
    const uuid = this.hap.uuid.generate(id);
    let acc = this.accessories.get(uuid);

    if (!acc) {
      acc = new this.api.platformAccessory(`Litter-Robot ${id.slice(-4)}`, uuid);
      acc.context.robotId = id;

      const sw = acc.addService(this.Service.Switch, 'Cycle Now');
      sw.getCharacteristic(this.Characteristic.On).onSet((val) => {
        if (!val) return;
        this.request('POST', Number(this.config.port ?? 8765), `/cycle/${id}`, {}, (err2) => {
          if (err2) this.log.warn(`Cycle command failed: ${errMsg(err2)}`);
          setTimeout(() => sw.updateCharacteristic(this.Characteristic.On, false), 500);
        });
      });

      acc.addService(this.Service.ContactSensor, 'Bonnet', 'Bonnet');
      acc.addService(this.Service.ContactSensor, 'Pinch', 'Pinch');
      acc.addService(this.Service.OccupancySensor, 'Offline', 'Offline');
      acc.addService(this.Service.MotionSensor, 'Cycle Completed', 'CycleCompleted');
      acc.addService(this.Service.ContactSensor, 'Cycle Fault', 'CycleFault');

      (acc.context as any)._last = { cycle: false, idle: false, code: null as string | null };
      (acc.context as any)._pulseMs = pulseMs;

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      this.accessories.set(uuid, acc);
    }
  }

  // ---------- polling ----------
  private pollOnce(port: number, debug: boolean, pulseMs: number): void {
    for (const acc of this.accessories.values()) {
      const id = String((acc.context as any).robotId ?? '');
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

        const last = ((acc.context as any)._last ?? { cycle: false, idle: false, code: null as string | null });
        if (last.cycle && !st.cycle && st.idle && completedSvc) {
          const ms = Number((acc.context as any)._pulseMs ?? pulseMs);
          completedSvc.updateCharacteristic(this.Characteristic.MotionDetected, true);
          setTimeout(() => completedSvc.updateCharacteristic(this.Characteristic.MotionDetected, false), ms);
        }

        (acc.context as any)._last = { cycle: st.cycle, idle: st.idle, code: st.status_code };

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
    this.request('GET', port, `/status/${id}`, undefined, (err, body) => {
      if (err) {
        if (this.log.debug) this.log.debug(`status error ${errMsg(err)}`);
        return;
      }
      try {
        const p = JSON.parse(body ?? '{}') as Partial<Status> & { id?: unknown };
        if (typeof p.id !== 'string') return;

        const s: Status = {
          id: p.id,
          name: typeof p.name === 'string' ? p.name : p.id,
          status_code: (p as any).status_code ?? null,
          status_label: (p as any).status_label ?? null,
          cycle: Boolean((p as any).cycle),
          idle: Boolean((p as any).idle),
          pinch: Boolean((p as any).pinch),
          bonnet: Boolean((p as any).bonnet),
          home: Boolean((p as any).home),
          paused: Boolean((p as any).paused),
          offline: Boolean((p as any).offline),
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
    data: unknown | undefined,
    cb: (err: Error | null, body?: string) => void,
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
      res.on('data', (c: Buffer | string) => { out += c.toString(); });
      res.on('end', () => cb(null, out));
    });

    req.on('error', (e: Error) => cb(e));
    if (payload) req.write(payload);
    req.end();
  }
}

/* ---------- small helpers ---------- */

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

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
