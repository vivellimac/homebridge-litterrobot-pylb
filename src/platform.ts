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

import { initRootLogger } from './log.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

interface RobotStatus {
  id: string;
  name: string;
  status_code?: string | null;
  status_label?: string | null;
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
  private healthTimer?: NodeJS.Timeout;
  private host = '127.0.0.1';
  private port = 8765;
  private pulseMs = 1500;
  private pollInterval = 10000;
  private debug = false;

  constructor(
    private readonly log: Logger,
    private readonly config: PlatformConfig,
    private readonly api: API,
  ) {
    initRootLogger(log);
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

  private start(): void {
    this.port = Number(this.config.port ?? 8765);
    this.host = String(this.config.host ?? '127.0.0.1').trim() || '127.0.0.1';
    const workdir = String(this.config.workdir ?? path.join(this.api.user.storagePath(), 'lr-sidecar'));
    const pyExec = String(this.config.python ?? '/usr/bin/python3');
    this.debug = Boolean(this.config.debug);
    this.pulseMs = Math.max(250, Math.min(10000, Number(this.config.pulseMs ?? 1500)));
    this.pollInterval = Math.max(3000, Math.min(60000, Number(this.config.pollInterval ?? 10000)));

    const username = String(this.config.username ?? '');
    const password = String(this.config.password ?? '');
    if (!username || !password) {
      this.log.warn('Missing username/password in config — plugin idle.');
      return;
    }

    fs.mkdirSync(workdir, { recursive: true });
    const pluginDir = path.join(this.api.user.storagePath(), 'node_modules', PLUGIN_NAME);
    const bootstrap = path.join(pluginDir, 'sidecar', 'bootstrap.py');

    try {
      this.py = spawn(pyExec, [bootstrap, '--workdir', workdir, '--port', String(this.port)], { stdio: 'ignore' });
      this.py.on('exit', (code, signal) => {
        this.log.warn(`Sidecar exited (code=${code ?? 'n/a'} signal=${signal ?? 'n/a'})`);
      });
    } catch (e) {
      this.log.error('Failed to spawn sidecar:', String(e));
    }

    this.waitForHealth()
      .then((ok) => {
        if (!ok) {
          this.log.error(`Sidecar unreachable at http://${this.host}:${this.port} — plugin idle.`);
          return;
        }
        this.loginAndDiscover(username, password);
      })
      .catch((e) => this.log.error('Health check error:', String(e)));
  }

  private stop(): void {
    if (this.healthTimer) {
      clearTimeout(this.healthTimer);
      this.healthTimer = undefined;
    }
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
    if (this.py) {
      try { this.py.kill(); } catch { /* ignore */ }
      this.py = null;
    }
  }

  private async waitForHealth(): Promise<boolean> {
    let delay = 1000;
    for (let i = 0; i < 6; i++) {
      const ok = await this.healthOnce();
      if (ok) {
        if (this.debug) this.log.info(`Sidecar healthy at http://${this.host}:${this.port}`);
        return true;
      }
      this.log.warn(`Sidecar not reachable at http://${this.host}:${this.port}; retrying in ${Math.round(delay / 1000)}s`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((r) => { this.healthTimer = setTimeout(() => r(), delay); });
      delay = Math.min(delay * 2, 30000);
    }
    return this.healthOnce();
  }

  private healthOnce(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.request('GET', this.host, this.port, '/health', undefined, (err, body) => {
        if (err) return resolve(false);
        try {
          const parsed = JSON.parse(body ?? '{}') as { ok?: unknown };
          resolve(Boolean(parsed.ok));
        } catch {
          resolve(false);
        }
      });
    });
  }

  private loginAndDiscover(username: string, password: string): void {
    this.request('POST', this.host, this.port, '/login', { username, password }, (err, body) => {
      if (err) {
        this.log.error('Login failed:', err.message);
        return;
      }
      try {
        const parsed = JSON.parse(body ?? '{}') as { robots?: unknown };
        const ids: string[] = Array.isArray(parsed.robots)
          ? (parsed.robots as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];

        if (ids.length === 0) {
          this.log.warn('No robots returned from sidecar login; will still start polling.');
        }

        ids.forEach((id) => this.upsertRobot(id, this.pulseMs));
        if (this.poll) clearInterval(this.poll);
        this.poll = setInterval(() => this.pollOnce(this.debug, this.pulseMs), this.pollInterval);
      } catch (e) {
        this.log.error('Login parse error:', String(e));
      }
    });
  }

  private upsertRobot(id: string, pulseMs: number): void {
    const uuid = this.api.hap.uuid.generate(id);
    let acc = this.accessories.get(uuid);

    if (!acc) {
      acc = new this.api.platformAccessory(`Litter-Robot ${id.slice(-4)}`, uuid);
      acc.context.robotId = id;

      const sw = acc.addService(this.Service.Switch, 'Cycle Now');
      sw.getCharacteristic(this.Characteristic.On).onSet((val) => {
        if (!val) return;
        this.request('POST', this.host, this.port, `/cycle/${id}`, {}, (err) => {
          if (err) this.log.warn('Cycle command failed:', String(err));
          setTimeout(() => sw.updateCharacteristic(this.Characteristic.On, false), 500);
        });
      });

      acc.addService(this.Service.ContactSensor, 'Bonnet', 'Bonnet');
      acc.addService(this.Service.ContactSensor, 'Pinch', 'Pinch');
      acc.addService(this.Service.OccupancySensor, 'Offline', 'Offline');
      acc.addService(this.Service.MotionSensor, 'Cycle Completed', 'CycleCompleted');
      acc.addService(this.Service.ContactSensor, 'Cycle Fault', 'CycleFault');

      acc.context._last = { cycle: false, idle: false, code: null as string | null };
      acc.context._pulseMs = pulseMs;

      // NOTE: first arg must be the plugin's package name
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      this.accessories.set(uuid, acc);
    }
  }

  private pollOnce(debug: boolean, pulseMs: number): void {
    for (const acc of this.accessories.values()) {
      const id = String(acc.context.robotId ?? '');
      if (!id) continue;

      this.getStatus(id, (st) => {
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

        const code = st.status_code ?? null;
        const label = st.status_label ?? null;
        acc.context._last = { cycle: st.cycle, idle: st.idle, code };

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

  private getStatus(id: string, cb: (s: RobotStatus) => void): void {
    this.request('GET', this.host, this.port, `/status/${encodeURIComponent(id)}`, undefined, (err, body) => {
      if (err) {
        this.log.debug?.('status error', String(err));
        return;
      }
      try {
        const parsed = JSON.parse(body ?? '{}') as Partial<RobotStatus>;
        if (typeof parsed.id !== 'string') return;

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
        // ignore parse errors to avoid spam
      }
    });
  }

  private request(
    method: 'GET' | 'POST',
    host: string,
    port: number,
    pathName: string,
    data: unknown,
    cb: (err?: Error | null, body?: string) => void,
  ): void {
    const payload = data != null ? Buffer.from(JSON.stringify(data)) : undefined;
    const req = http.request(
      { host, port, path: pathName, method, headers: payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : undefined, timeout: 8000 },
      (res) => {
        let out = '';
        res.on('data', (c: Buffer) => { out += c.toString('utf8'); });
        res.on('end', () => cb(null, out));
      },
    );
    req.on('error', (e: Error) => cb(e));
    if (payload) req.write(payload);
    req.end();
  }
}
