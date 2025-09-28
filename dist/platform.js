"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LitterRobotPlatform = void 0;
const settings_1 = require("./settings");
const log_1 = require("./log");
const node_child_process_1 = require("node:child_process");
const node_http_1 = require("node:http");
const node_path_1 = require("node:path");
const node_fs_1 = require("node:fs");
class LitterRobotPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = new Map();
    this.py = null;
    (0, log_1.initRootLogger)(log);
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    if (!this.config) {
      this.log.warn('No config block provided; skipping initialization.');
      return;
    }
    this.api.on('didFinishLaunching', () => this.start());
    this.api.on('shutdown', () => this.stop());
  }
  configureAccessory(acc) {
    this.accessories.set(acc.UUID, acc);
  }
  // ---------- lifecycle ----------
  start() {
    const port = Number(this.config.port ?? 8765);
    const workdir = String(this.config.workdir ?? (0, node_path_1.join)(this.api.user.storagePath(), 'lr-sidecar'));
    const pyExec = String(this.config.python ?? '/usr/bin/python3');
    const debug = Boolean(this.config.debug);
    const pulseMs = Math.max(250, Math.min(10000, Number(this.config.pulseMs ?? 1500)));
    const pollInterval = Math.max(3000, Math.min(60000, Number(this.config.pollInterval ?? 5000)));
    const username = String(this.config.username ?? '');
    const password = String(this.config.password ?? '');
    if (!username || !password) {
      this.log.warn('Missing username/password in config — plugin idle.');
      return;
    }
    (0, node_fs_1.mkdirSync)(workdir, { recursive: true });
    const pluginDir = (0, node_path_1.join)(this.api.user.storagePath(), 'node_modules', settings_1.PLUGIN_NAME);
    const bootstrap = (0, node_path_1.join)(pluginDir, 'sidecar', 'bootstrap.py');
    this.py = (0, node_child_process_1.spawn)(pyExec, [bootstrap, '--workdir', workdir, '--port', String(port)], { stdio: 'ignore' });
    this.request('POST', port, '/login', { username, password }, (err, body) => {
      if (err) {
        this.log.error('Login failed:', err.message);
        return;
      }
      try {
        const parsed = JSON.parse(body ?? '{}');
        const ids = Array.isArray(parsed.robots)
          ? parsed.robots.filter((x) => typeof x === 'string')
          : [];
        ids.forEach((id) => this.upsertRobot(id, pulseMs));
        if (this.poll) {
          clearInterval(this.poll);
        }
        this.poll = setInterval(() => this.pollOnce(port, debug, pulseMs), pollInterval);
      }
      catch (e) {
        this.log.error('Login parse error', String(e));
      }
    });
  }
  stop() {
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
    if (this.py) {
      this.py.kill();
      this.py = null;
    }
  }
  // ---------- accessories ----------
  upsertRobot(id, pulseMs) {
    const uuid = this.api.hap.uuid.generate(id);
    let acc = this.accessories.get(uuid);
    if (!acc) {
      acc = new this.api.platformAccessory(`Litter-Robot ${id.slice(-4)}`, uuid);
      acc.context.robotId = id;
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
      acc.addService(this.Service.ContactSensor, 'Bonnet', 'Bonnet');
      acc.addService(this.Service.ContactSensor, 'Pinch', 'Pinch');
      acc.addService(this.Service.OccupancySensor, 'Offline', 'Offline');
      acc.addService(this.Service.MotionSensor, 'Cycle Completed', 'CycleCompleted');
      acc.addService(this.Service.ContactSensor, 'Cycle Fault', 'CycleFault');
      acc.context._last = { cycle: false, idle: false, code: null };
      acc.context._pulseMs = pulseMs;
      this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [acc]);
      this.accessories.set(uuid, acc);
    }
  }
  // ---------- polling / mapping ----------
  pollOnce(port, debug, pulseMs) {
    for (const acc of this.accessories.values()) {
      const id = String(acc.context.robotId ?? '');
      if (!id) {
        continue;
      }
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
          bonnetSvc.updateCharacteristic(this.Characteristic.ContactSensorState, st.bonnet
            ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
            : this.Characteristic.ContactSensorState.CONTACT_DETECTED);
        }
        if (pinchSvc) {
          pinchSvc.updateCharacteristic(this.Characteristic.ContactSensorState, st.pinch
            ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
            : this.Characteristic.ContactSensorState.CONTACT_DETECTED);
        }
        if (offlineSvc) {
          offlineSvc.updateCharacteristic(this.Characteristic.OccupancyDetected, st.offline
            ? this.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
            : this.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
        }
        const isFault = Boolean(st.pinch || st.bonnet || st.paused || st.offline);
        if (faultSvc) {
          faultSvc.updateCharacteristic(this.Characteristic.ContactSensorState, isFault
            ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
            : this.Characteristic.ContactSensorState.CONTACT_DETECTED);
        }
        const last = (acc.context._last ?? { cycle: false, idle: false, code: null });
        if (last.cycle && !st.cycle && st.idle) {
          const ms = Number(acc.context._pulseMs ?? pulseMs);
          if (completedSvc) {
            completedSvc.updateCharacteristic(this.Characteristic.MotionDetected, true);
            setTimeout(() => {
              completedSvc.updateCharacteristic(this.Characteristic.MotionDetected, false);
            }, ms);
          }
        }
        const code = (st.status_code ?? null);
        const label = (st.status_label ?? null);
        acc.context._last = { cycle: st.cycle, idle: st.idle, code };
        if (debug) {
          this.log.info(`status: code=${code ?? 'n/a'}${label ? `(${label})` : ''} ` +
            `cycle=${st.cycle} idle=${st.idle} pinch=${st.pinch} bonnet=${st.bonnet} ` +
            `home=${st.home} paused=${st.paused} offline=${st.offline}`);
        }
      });
    }
  }
  getStatus(id, port, cb) {
    this.request('GET', port, `/status/${id}`, undefined, (err, body) => {
      var _a;
      if (err) {
        (_a = this.log.debug) === null || _a === void 0 ? void 0 : _a.call(this.log, 'status error', String(err));
        return;
      }
      try {
        const parsed = JSON.parse(body ?? '{}');
        if (typeof parsed.id !== 'string') {
          return;
        }
        const s = {
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
      }
      catch (_b) {
        // ignore parse errors silently to avoid log spam
      }
    });
  }
  // ---------- http helper ----------
  request(method, port, pathName, data, cb) {
    const payload = data != null ? Buffer.from(JSON.stringify(data)) : undefined;
    const req = (0, node_http_1.request)({
      host: '127.0.0.1',
      port,
      path: pathName,
      method,
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
        : undefined,
      timeout: 8000,
    }, (res) => {
      let out = '';
      res.on('data', (c) => {
        out += c.toString('utf8');
      });
      res.on('end', () => cb(null, out));
    });
    req.on('error', (e) => cb(e));
    if (payload) {
      req.write(payload);
    }
    req.end();
  }
}
exports.LitterRobotPlatform = LitterRobotPlatform;
