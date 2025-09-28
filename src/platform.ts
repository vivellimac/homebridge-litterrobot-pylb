import type {
  API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { initRootLogger } from './log.js';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

interface RobotStatus {
  id: string;
  name: string;
  status_code?: string | null;   // e.g. "ccc", "ccp", "csf", ...
  status_label?: string | null;  // human-readable label from sidecar
  cycle: boolean;
  idle: boolean;
  pinch: boolean;
  bonnet: boolean;
  home: boolean;
  paused: boolean;
  offline: boolean;
}

export class LitterRobotPlatform implements DynamicPlatformPlugin {
  public Service!: typeof Service;
  public Characteristic!: typeof Characteristic;

  private accessories = new Map<string, PlatformAccessory>();
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

    this.api.on('didFinishLaunching', () => this.start());
    this.api.on('shutdown', () => this.stop());
  }

  configureAccessory(acc: PlatformAccessory) {
    this.accessories.set(acc.UUID, acc);
  }

  private start() {
    const port = Number(this.config.port ?? 8765);
    const workdir = String(this.config.workdir ?? path.join(this.api.user.storagePath(), 'lr-sidecar'));
    const pyExec = String(this.config.python ?? '/usr/bin/python3');
    const debug = Boolean(this.config.debug);
    const pulseMs = Math.max(250, Math.min(10000, Number(this.config.pulseMs ?? 1500)));

    const username = String(this.config.username ?? '');
    const password = String(this.config.password ?? '');
    if (!username || !password) {
      this.log.warn('Missing username/password in config — plugin idle.');
      return;
    }

    fs.mkdirSync(workdir, { recursive: true });

    // Resolve the plugin install dir under Homebridge's storagePath()
    const pluginDir = path.join(this.api.user.storagePath(), 'node_modules', PLUGIN_NAME);
    const bootstrap = path.join(pluginDir, 'sidecar', 'bootstrap.py');

    this.py = spawn(pyExec, [bootstrap, '--workdir', workdir, '--port', String(port)], { stdio: 'ignore' });

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
        this.schedulePoll(port, debug, pulseMs);
      } catch (e) {
        this.log.error('Login parse error', String(e));
      }
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

  private upsertRobot(id: string, pulseMs: number) {
    const uuid = this.api.hap.uuid.generate(id);
    let acc = this.accessories.get(uuid);
    if (!acc) {
      acc = new this.api.platformAccessory(`Litter-Robot ${id.slice(-4)}`, uuid);
      acc.context.robotId = id;

      // Controls
      const sw = acc.addService(this.Service.Switch, 'Cycle Now');
      sw.getCharacteristic(this.Characteristic.On).onSet((val) => {
        if (!val) {
          return;
        }
        this.request('POST', Number(this.config.port ?? 8765), `/cycle/${id}`, {}, (err) => {
          if (err) {
            this.log.warn('Cycle command failed:', String(err));
          }
          setTimeout(() => {
            sw.updateCharacteristic(this.Characteristic.On, false);
          }, 500);
        });
      });

      // Simple state sensors
      acc.addService(this.Service.ContactSensor, 'Bonnet', 'Bonnet');
      acc.addService(this.Service.ContactSensor, 'Pinch', 'Pinch');
      acc.addService(this.Service.OccupancySensor, 'Offline', 'Offline');

      // Automation-friendly sensors
      acc.addService(this.Service.MotionSensor, 'Cycle Completed', 'CycleCompleted');
      acc.addService(this.Service.ContactSensor, 'Cycle Fault', 'CycleFault');

      // Track last state & last code for future transitions
      acc.context._last = { cycle: false, idle: false, code: null as string | null };

      // Pulse duration
      acc.context._pulseMs = pulseMs;

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      this.accessories.set(uuid, acc);
    }
  }

  private schedulePoll(port: number, debug: boolean, pulseMs: number) {
    const interval = Math.max(3000, Math.min(60000, Number(this.config.pollInterval ?? 5000)));
    this.poll = setInterval(() => {
      for (const acc of this.accessories.values()) {
        const id = acc.context.robotId as string;
        this.getStatus(id, port, (st) => {
          // Reflect switch
          acc.getService(this.Service.Switch)?.updateCharacteristic(this.Characteristic.On, st.cycle);

          // Basic sensors
          acc.getService('Bonnet')?.updateCharacteristic(this.Characteristic.ContactSensorState, st.bonnet ? 1 : 0);
          acc.getService('Pinch')?.updateCharacteristic(this.Characteristic.ContactSensorState, st.pinch ? 1 : 0);
          acc.getService('Offline')?.updateCharacteristic(this.Characteristic.OccupancyDetected, st.offline ? 1 : 0);

          // Fault (OPEN on any fault-ish condition)
          const isFault = Boolean(st.pinch || st.bonnet || st.paused || st.offline);
          acc.getService('CycleFault')?.updateCharacteristic(this.Characteristic.ContactSensorState, isFault ? 1 : 0);

          // Completed pulse by state transition (cycle -> false && idle -> true)
          const last = acc.context._last as { cycle: boolean; idle: boolean; code: string | null };
          if (last.cycle && !st.cycle && st.idle) {
            const ms = Number(acc.context._pulseMs ?? pulseMs);
            const svc = acc.getService('CycleCompleted');
            svc?.updateCharacteristic(this.Characteristic.MotionDetected, true);
            setTimeout(() => {
              svc?.updateCharacteristic(this.Characteristic.MotionDetected, false);
            }, ms);
          }

          // Capture raw status_code for future transitions
          const code = st.status_code ?? null;
          const label = st.status_label ?? null;
          acc.context._last = { cycle: st.cycle, idle: st.idle, code };

          // Heartbeat
          if (debug) {
            this.log.info(
              `status: code=${code ?? 'n/a'}${label ? `(${label})` : ''} cycle=${st.cycle} idle=${st.idle} ` +
              `pinch=${st.pinch} bonnet=${st.bonnet} home=${st.home} paused=${st.paused} offline=${st.offline}`,
            );
          }
        });
      }
    }, interval);
  }

  private getStatus(id: string, port: number, cb: (s: RobotStatus) => void) {
    this.request('GET', port, `/status/${id}`, undefined, (err, body) => {
      if (err) {
        this.log.debug?.('status error', String(err));
        return;
      }
      try {
        const parsed = JSON.parse(body ?? '{}') as Partial<RobotStatus>;
        // Basic shape validation
        if (typeof parsed.id !== 'string') {
          return;
        }
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
        headers: payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : undefined,
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
    req.on('error', (e: Error) => cb(e)); // <- no assertion, typed param
    if (payload) {
      req.write(payload);
    }
    req.end();
  }
}
