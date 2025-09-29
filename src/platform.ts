import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import { initRootLogger } from './log';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

interface RobotStatus {
  id: string;
  name: string;
  status_code?: string | null;    // raw code from sidecar (string or null)
  status_label?: string | null;   // human-readable label from sidecar
  cycle: boolean;
  idle: boolean;
  pinch: boolean;
  bonnet: boolean;
  home: boolean;
  paused: boolean;
  offline: boolean;
}

interface LastState {
  cycle: boolean;
  idle: boolean;
  code: string | null;
}

export class LitterRobotPlatform implements DynamicPlatformPlugin {
  public Service!: typeof Service;
  public Characteristic!: typeof Characteristic;

  private readonly accessories = new Map<string, PlatformAccessory>();
  private py: ChildProcess | null = null;
  private poll?: NodeJS.Timeout;

  constructor(
    private readonly log: Logger,
    private readonly config: PlatformConfig,
    private readonly api: API,
  ) {
    initRootLogger(log);

    // Initialize HAP types AFTER 'api' is available
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    if (!this.config) {
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

  private start() {
    // Clamp / read config
    const port = Number(this.config.port ?? 8765);
    const workdir = String(this.config.workdir ?? path.join(this.api.user.storagePath(), 'lr-sidecar'));
    const debug = Boolean(this.config.debug);
    const pulseMs = Math.max(250, Math.min(10_000, Number(this.config.pulseMs ?? 1500)));
    const pollInterval = Math.max(3000, Math.min(60_000, Number(this.config.pollInterval ?? 5000)));

    const username = String(this.config.username ?? '');
    const password = String(this.config.password ?? '');
    if (!username || !password) {
      this.log.warn('Missing username/password in config — plugin idle.');
      return;
    }

    // Ensure workdir exists
    fs.mkdirSync(workdir, { recursive: true });

    // Resolve bootstrap from the installed package (avoid guessing under storagePath)
    const bootstrap = path.resolve(__dirname, '..', 'sidecar', 'bootstrap.py');

    // Prefer a previously-created venv inside workdir, else user override, else system default
    const venvPy = path.join(workdir, '.venv', 'bin', 'python');
    const pyExec = fs.existsSync(venvPy)
      ? venvPy
      : String(this.config.python ?? 'python3');

    // 1) See if a sidecar is already up
    this.checkHealthOnce(port, (healthy) => {
      if (healthy) {
        this.log.info(`Sidecar healthy at http://127.0.0.1:${port}`);
        this.doLoginAndStartPolling({ port, username, password, pulseMs, pollInterval, debug });
        return;
      }

      // 2) Not healthy — spawn bootstrap to set up venv + run uvicorn
      try {
        this.py = spawn(pyExec, [bootstrap, '--workdir', workdir, '--port', String(port)], {
          stdio: 'ignore',
        });

        this.py.on('exit', (code, signal) => {
          this.log.warn(`Sidecar exited (code=${code ?? 'n/a'} signal=${signal ?? 'n/a'})`);
        });
      } catch (e) {
        this.log.error('Failed to spawn sidecar:', (e as Error).message);
        // Bail early; without sidecar nothing else works
        return;
      }

      // 3) Wait for /health to come up, then proceed to login
      this.waitForHealth(port, 20, 750, (ok) => {
        if (!ok) {
          this.log.error('Sidecar did not become healthy in time.');
          return;
        }
        this.log.info(`Sidecar healthy at http://127.0.0.1:${port}`);
        this.doLoginAndStartPolling({ port, username, password, pulseMs, pollInterval, debug });
      });
    });
  }

  private stop() {
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
    if (this.py) {
      this.py.kill();
      this.py = null;
    }
  }

  // ---------- bootstrap / health ----------

  private checkHealthOnce(port: number, cb: (ok: boolean) => void) {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        timeout: 2000,
      },
      (res) => {
        let out = '';
        res.on('data', (c: Buffer) => (out += c.toString('utf8')));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(out || '{}');
            cb(Boolean(parsed.ok));
          } catch {
            cb(false);
          }
        });
      },
    );
    req.on('error', () => cb(false));
    req.end();
  }

  private waitForHealth(
    port: number,
    attempts: number,
    intervalMs: number,
    cb: (ok: boolean) => void,
  ) {
    let remaining = attempts;
    const tick = () => {
      this.checkHealthOnce(port, (ok) => {
        if (ok) {
          cb(true);
          return;
        }
        remaining -= 1;
        if (remaining <= 0) {
          cb(false);
          return;
        }
        setTimeout(tick, intervalMs);
      });
    };
    tick();
  }

  private doLoginAndStartPolling(opts: {
    port: number;
    username: string;
    password: string;
    pulseMs: number;
    pollInterval: number;
    debug: boolean;
  }) {
    const { port, username, password, pulseMs, pollInterval, debug } = opts;

    this.request('POST', port, '/login', { username, password }, (err, body) => {
      if (err) {
        this.log.error('Login failed:', err.message);
        return;
      }
      try {
        const parsed = JSON.parse(body ?? '{}') as { robots?: unknown };
        const ids: string[] = Array.isArray(parsed.robots)
          ? (parsed.robots as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];

        ids.forEach((id) => this.upsertRobot(id, pulseMs));

        if (this.poll) {
          clearInterval(this.poll);
        }
        this.poll = setInterval(() => this.pollOnce(port, debug, pulseMs), pollInterval);
      } catch (e) {
        this.log.error('Login parse error', String(e));
      }
    });
  }

  // ---------- accessories ----------

  private upsertRobot(id: string, pulseMs: number) {
    const uuid = this.api.hap.uuid.generate(id);
    let acc = this.accessories.get(uuid);

    if (!acc) {
      acc = new this.api.platformAccessory(`Litter-Robot ${id.slice(-4)}`, uuid);
      acc.context.robotId = id;

      // Controls
      const sw = acc.addService(this.Service.Switch, 'Cycle Now');
      sw.getCharacteristic(this.Characteristic.On).onSet((val) => {
        if (!val) return;
        this.request('POST', Number(this.config.port ?? 8765), `/cycle/${id}`, {}, (err) => {
          if (err) {
            this.log.warn('Cycle command failed:', String(err));
          }
          setTimeout(() => {
            sw.updateCharacteristic(this.Characteristic.On, false);
          }, 500);
        });
      });

      // Simple state sensors (fixed subtypes for stable lookups)
      acc.addService(this.Service.ContactSensor, 'Bonnet', 'Bonnet');
      acc.addService(this.Service.ContactSensor, 'Pinch', 'Pinch');
      acc.addService(this.Service.OccupancySensor, 'Offline', 'Offline');

      // Automation-friendly sensors
      acc.addService(this.Service.MotionSensor, 'Cycle Completed', 'CycleCompleted');
      acc.addService(this.Service.ContactSensor, 'Cycle Fault', 'CycleFault');

      // Track last state & pulse duration for transition pulses
      acc.context._last = { cycle: false, idle: false, code: null as string | null } as LastState;
      acc.context._pulseMs = pulseMs;

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      this.accessories.set(uuid, acc);
    }
  }

  // ---------- polling / mapping ----------

  private pollOnce(port: number, debug: boolean, pulseMs: number) {
    for (const acc of this.accessories.values()) {
      const id = String(acc.context.robotId ?? '');
      if (!id) continue;

      this.getStatus(id, port, (st) => {
        // Reflect switch
        const switchSvc = acc.getService(this.Service.Switch);
        if (switchSvc) {
          switchSvc.updateCharacteristic(this.Characteristic.On, st.cycle);
        }

        // Convenience lookups by subtype
        const bonnetSvc = acc.getServiceById(this.Service.ContactSensor, 'Bonnet');
        const pinchSvc = acc.getServiceById(this.Service.ContactSensor, 'Pinch');
        const offlineSvc = acc.getServiceById(this.Service.OccupancySensor, 'Offline');
        const completedSvc = acc.getServiceById(this.Service.MotionSensor, 'CycleCompleted');
        const faultSvc = acc.getServiceById(this.Service.ContactSensor, 'CycleFault');

        // Basic sensors
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

        // Fault (OPEN on any fault-ish condition)
        const isFault = Boolean(st.pinch || st.bonnet || st.paused || st.offline);
        if (faultSvc) {
          faultSvc.updateCharacteristic(
            this.Characteristic.ContactSensorState,
            isFault
              ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
              : this.Characteristic.ContactSensorState.CONTACT_DETECTED,
          );
        }

        // Completed pulse by state transition (cycle -> false && idle -> true)
        const last = (acc.context._last ?? { cycle: false, idle: false, code: null }) as LastState;
        if (last.cycle && !st.cycle && st.idle) {
          const ms = Number(acc.context._pulseMs ?? pulseMs);
          if (completedSvc) {
            completedSvc.updateCharacteristic(this.Characteristic.MotionDetected, true);
            setTimeout(() => {
              completedSvc.updateCharacteristic(this.Characteristic.MotionDetected, false);
            }, ms);
          }
        }

        // Capture raw status_code for future transitions
        const code = st.status_code ?? null;
        const label = st.status_label ?? null;
        acc.context._last = { cycle: st.cycle, idle: st.idle, code };

        // Heartbeat (single concise line)
        if (debug) {
          this.log.info(
            `status: code=${code ?? 'n/a'}${label ? `(${label})` : ''} ` +
              `cycle=${st.cycle} idle=${st.idle} pinch=${st.pinch} bonnet=${st.bonnet} ` +
              `home=${st.home} paused=${st.paused} offline=${st.offline}`,
          );
        }
      });
    }
  }

  private getStatus(id: string, port: number, cb: (s: RobotStatus) => void) {
    this.request('GET', port, `/status/${id}`, undefined, (err, body) => {
      if (err) {
        this.log.debug?.('status error', String(err));
        return;
      }
      try {
        const parsed = JSON.parse(body ?? '{}') as Partial<RobotStatus>;
        if (typeof parsed.id !== 'string') return;

        // Fill required booleans with safe defaults if missing
        const s: RobotStatus = {
          id: parsed.id,
          name: typeof parsed.name === 'string' ? parsed.name : parsed.id,
          status_code: parsed.status_code ?? null,
          status_label: parsed.status_label ?? null,
          cycle: Boolean(parsed.cycle),
          idle: Boolean(parsed.idle),
          pinch: Boolean(parsed.pinch),
          bonnet: Boolean(parsed.bonnet),
          home: Boolean(parsed.home),
          paused: Boolean(parsed.paused),
          offline: Boolean(parsed.offline),
        };
        cb(s);
      } catch {
        // ignore parse errors silently to avoid log spam
      }
    });
  }

  // ---------- http helper ----------

  private request(
    method: 'GET' | 'POST',
    port: number,
    pathName: string,
    data: unknown,
    cb: (err?: Error | null, body?: string) => void,
  ) {
    const payload = data != null ? Buffer.from(JSON.stringify(data)) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathName,
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
          : undefined,
        timeout: 8000,
      },
      (res) => {
        let out = '';
        res.on('data', (c: Buffer) => {
          out += c.toString('utf8');
        });
        res.on('end', () => cb(null, out));
      },
    );
    req.on('error', (e: Error) => cb(e));
    if (payload) req.write(payload);
    req.end();
  }
}
