"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LitterRobotPlatform = void 0;
/* Node core (must come first for eslint import/order)  */
const node_child_process_1 = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
/* Internal */
const log_1 = require("./log");
const settings_1 = require("./settings");
/* ---------- safe config helpers ---------- */
function asObject(v) {
    return v !== null && typeof v === 'object' ? v : undefined;
}
function readBoolean(obj, key) {
    const v = obj?.[key];
    return typeof v === 'boolean' ? v : undefined;
}
function readNumber(obj, key) {
    const v = obj?.[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function readString(obj, key) {
    const v = obj?.[key];
    return typeof v === 'string' ? v : undefined;
}
/* ---------- platform ---------- */
class LitterRobotPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.accessories = new Map();
        this.py = null;
        // advanced flags captured at start()
        this.adv = {};
        // runtime basics captured at start()
        this.runtimePort = 8765;
        this.runtimeWorkdir = '';
        this.runtimeDebug = false;
        (0, log_1.initRootLogger)(log);
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
    configureAccessory(acc) {
        this.accessories.set(acc.UUID, acc);
    }
    // ---------- lifecycle ----------
    start() {
        // Safely read advanced group (nested) with fallbacks
        const cfgRoot = asObject(this.config);
        const advRoot = cfgRoot ? asObject(cfgRoot.advanced) : undefined;
        const drawerRoot = advRoot ? asObject(advRoot.drawer) : undefined;
        const cycleRoot = advRoot ? asObject(advRoot.cycleInterrupt) : undefined;
        // Capture advanced toggles for later use (accessory layout, timers)
        this.adv = {
            bonnet: readBoolean(advRoot, 'bonnetSensor') ?? false,
            drawerControl: readBoolean(drawerRoot, 'enable') ?? false,
            interruptTimeoutEnabled: readBoolean(cycleRoot, 'enabled') ?? false,
            interruptTimeoutMins: clampNumber(readNumber(cycleRoot, 'minutes') ?? 5, 1, 120),
        };
        // Port/workdir/debug can come from advanced.* or top-level (back-compat)
        const topPort = readNumber(cfgRoot, 'port');
        const advPort = readNumber(advRoot, 'port');
        this.runtimePort = Number.isFinite(advPort ?? topPort) ? (advPort ?? topPort) : 8765;
        const topWorkdir = readString(cfgRoot, 'workdir');
        const advWorkdir = readString(advRoot, 'workdir');
        this.runtimeWorkdir = String(advWorkdir ?? topWorkdir ?? path.join(this.api.user.storagePath(), 'lr-sidecar'));
        const topDebug = readBoolean(cfgRoot, 'debug');
        const advDebug = readBoolean(advRoot, 'debug');
        this.runtimeDebug = Boolean(advDebug ?? topDebug ?? false);
        const pulseMs = clampNumber(typeof cfgRoot?.pulseMs === 'number' ? cfgRoot.pulseMs : 1500, 250, 10000);
        const pollInterval = clampNumber(typeof cfgRoot?.pollInterval === 'number' ? cfgRoot.pollInterval : 5000, 3000, 60000);
        const username = readString(cfgRoot, 'username') ?? '';
        const password = readString(cfgRoot, 'password') ?? '';
        if (!username || !password) {
            this.log.warn('Missing username/password in config — plugin idle.');
            return;
        }
        try {
            fs.mkdirSync(this.runtimeWorkdir, { recursive: true });
        }
        catch (e) {
            this.log.error(`Failed to create workdir ${this.runtimeWorkdir}: ${errMsg(e)}`);
            return;
        }
        const systemPy = readString(cfgRoot, 'python') ?? 'python3';
        const venvDir = path.join(this.runtimeWorkdir, '.venv');
        const venvPy = path.join(venvDir, 'bin', 'python');
        const pluginDir = path.resolve(this.api.user.storagePath(), 'node_modules', settings_1.PLUGIN_NAME);
        const bootstrap = path.join(pluginDir, 'sidecar', 'bootstrap.py');
        const bLog = path.join(this.runtimeWorkdir, 'bootstrap.log');
        if (this.runtimeDebug) {
            this.log.info(`[sidecar] workdir=${this.runtimeWorkdir} port=${this.runtimePort} bootstrap=${bootstrap} `
                + `systemPy=${systemPy} venvPy=${venvPy}`);
        }
        // First: quick health probe (no tail yet to avoid log spam on warm starts)
        this.log.info('[sidecar] Waiting for /health ...');
        waitForHealth(this.runtimePort, 2000).then((healthyFast) => {
            if (healthyFast) {
                this.log.info(`Sidecar healthy at http://127.0.0.1:${this.runtimePort}`);
                this.loginAndBegin(username, password, this.runtimePort, pulseMs, pollInterval, this.runtimeDebug);
                return;
            }
            // Not healthy: we are about to bootstrap → start tail now
            this.tailStop = tailBootstrapLog(bLog, (line) => this.log.info(`[sidecar] ${line}`));
            this.log.info('[sidecar] Not healthy; invoking bootstrap …');
            try {
                this.py = (0, node_child_process_1.spawn)(systemPy, [bootstrap, '--workdir', this.runtimeWorkdir, '--port', String(this.runtimePort)], {
                    stdio: 'ignore',
                    env: process.env,
                });
                this.py.on('exit', (code, signal) => {
                    this.log.warn(`Sidecar exited (code=${code ?? 'n/a'} signal=${signal ?? 'n/a'})`);
                });
            }
            catch (e) {
                this.log.error(`Failed to spawn bootstrap with ${systemPy}: ${errMsg(e)} (hint: ensure ${systemPy} exists)`);
                try {
                    this.tailStop?.();
                }
                catch { /* ignore */ }
                return;
            }
            // Adaptive wait: keep waiting while bootstrap.log is active (up to 15m)
            return waitForHealthAdaptive(this.runtimePort, bLog, 45000, 900000).then((ok2) => {
                try {
                    this.tailStop?.();
                }
                catch { /* ignore */ }
                if (!ok2) {
                    this.log.error('Sidecar failed to start after bootstrap (no health and no recent bootstrap activity).');
                    return;
                }
                const venvOk = fs.existsSync(venvPy);
                if (this.runtimeDebug)
                    this.log.info(`[sidecar] venv python present: ${venvOk ? 'yes' : 'no'}`);
                this.log.info(`Sidecar healthy at http://127.0.0.1:${this.runtimePort}`);
                this.loginAndBegin(username, password, this.runtimePort, pulseMs, pollInterval, this.runtimeDebug);
            });
        }).catch((e) => {
            this.log.error(`Health check error: ${errMsg(e)}`);
        });
    }
    stop() {
        if (this.poll) {
            clearInterval(this.poll);
            this.poll = undefined;
        }
        try {
            this.tailStop?.();
        }
        catch { /* ignore */ }
        if (this.py) {
            this.py.kill();
            this.py = null;
        }
    }
    // ---------- after healthy ----------
    loginAndBegin(username, password, port, pulseMs, pollInterval, debug) {
        this.request('POST', port, '/login', (err, body) => {
            if (err) {
                this.log.error(`Login failed: ${errMsg(err)}`);
                return;
            }
            try {
                const parsed = JSON.parse(body ?? '{}');
                const ids = Array.isArray(parsed.robots)
                    ? parsed.robots.filter((x) => typeof x === 'string')
                    : [];
                ids.forEach((id) => this.upsertRobot(id, pulseMs));
                if (this.poll)
                    clearInterval(this.poll);
                this.poll = setInterval(() => this.pollOnce(port, debug, pulseMs), pollInterval);
            }
            catch (e) {
                this.log.error(`Login parse error: ${errMsg(e)}`);
            }
        }, { username, password });
    }
    // ---------- accessories ----------
    upsertRobot(id, pulseMs) {
        const uuid = this.hap.uuid.generate(id);
        let acc = this.accessories.get(uuid);
        if (!acc) {
            const newAcc = new this.api.platformAccessory(`Litter-Robot ${id.slice(-4)}`, uuid);
            newAcc.context.robotId = id;
            // Controls
            let swCycle = newAcc.getServiceById(this.Service.Switch, 'CycleNow');
            if (!swCycle)
                swCycle = newAcc.addService(this.Service.Switch, 'Cycle Now', 'CycleNow');
            let swLight = newAcc.getServiceById(this.Service.Switch, 'GlobeLight');
            if (!swLight)
                swLight = newAcc.addService(this.Service.Switch, 'Globe Light', 'GlobeLight');
            // Advanced: Drawer controls (HumiditySensors + Reset switch)
            if (this.adv.drawerControl) {
                if (!newAcc.getServiceById(this.Service.HumiditySensor, 'DrawerLevel')) {
                    newAcc.addService(this.Service.HumiditySensor, 'Drawer Level', 'DrawerLevel');
                }
                if (!newAcc.getServiceById(this.Service.HumiditySensor, 'LitterLevel')) {
                    newAcc.addService(this.Service.HumiditySensor, 'Litter Level', 'LitterLevel');
                }
                if (!newAcc.getServiceById(this.Service.Switch, 'ResetDrawer')) {
                    newAcc.addService(this.Service.Switch, 'Reset Drawer', 'ResetDrawer');
                }
            }
            else {
                const dl = newAcc.getServiceById(this.Service.HumiditySensor, 'DrawerLevel');
                if (dl)
                    newAcc.removeService(dl);
                const ll = newAcc.getServiceById(this.Service.HumiditySensor, 'LitterLevel');
                if (ll)
                    newAcc.removeService(ll);
                const rd = newAcc.getServiceById(this.Service.Switch, 'ResetDrawer');
                if (rd)
                    newAcc.removeService(rd);
            }
            // Advanced: Bonnet sensor
            if (this.adv.bonnet) {
                if (!newAcc.getServiceById(this.Service.ContactSensor, 'Bonnet')) {
                    newAcc.addService(this.Service.ContactSensor, 'Bonnet', 'Bonnet');
                }
            }
            else {
                const b = newAcc.getServiceById(this.Service.ContactSensor, 'Bonnet');
                if (b)
                    newAcc.removeService(b);
            }
            // Always-present sensors
            if (!newAcc.getServiceById(this.Service.ContactSensor, 'Pinch')) {
                newAcc.addService(this.Service.ContactSensor, 'Pinch', 'Pinch');
            }
            if (!newAcc.getServiceById(this.Service.OccupancySensor, 'Offline')) {
                newAcc.addService(this.Service.OccupancySensor, 'Offline', 'Offline');
            }
            if (!newAcc.getServiceById(this.Service.MotionSensor, 'CycleCompleted')) {
                newAcc.addService(this.Service.MotionSensor, 'Cycle Completed', 'CycleCompleted');
            }
            if (!newAcc.getServiceById(this.Service.ContactSensor, 'CycleFault')) {
                newAcc.addService(this.Service.ContactSensor, 'Cycle Fault', 'CycleFault');
            }
            // Advanced: Interrupted Timeout motion sensor
            const wantTimeout = Boolean(this.adv.interruptTimeoutEnabled) && Number(this.adv.interruptTimeoutMins ?? 0) > 0;
            if (wantTimeout) {
                if (!newAcc.getServiceById(this.Service.MotionSensor, 'InterruptedTimeout')) {
                    newAcc.addService(this.Service.MotionSensor, 'Interrupted Timeout', 'InterruptedTimeout');
                }
            }
            else {
                const it = newAcc.getServiceById(this.Service.MotionSensor, 'InterruptedTimeout');
                if (it)
                    newAcc.removeService(it);
            }
            // Handlers
            swCycle.getCharacteristic(this.Characteristic.On).onSet((val) => {
                if (!val)
                    return;
                this.request('POST', this.runtimePort, `/cycle/${id}`, (err2) => {
                    if (err2)
                        this.log.warn(`Cycle command failed: ${errMsg(err2)}`);
                    setTimeout(() => swCycle.updateCharacteristic(this.Characteristic.On, false), 300);
                }, {});
            });
            swLight.getCharacteristic(this.Characteristic.On).onSet((val) => {
                const desired = Boolean(val);
                this.request('POST', this.runtimePort, `/lights/${id}`, (err2) => {
                    if (err2) {
                        this.log.warn(`Light set failed: ${errMsg(err2)}`);
                        setTimeout(() => swLight.updateCharacteristic(this.Characteristic.On, !desired), 300);
                    }
                }, { on: desired });
            });
            const swReset = newAcc.getServiceById(this.Service.Switch, 'ResetDrawer');
            if (swReset) {
                swReset.getCharacteristic(this.Characteristic.On).onSet((val) => {
                    if (!val)
                        return;
                    this.request('POST', this.runtimePort, `/reset_drawer/${id}`, (err2) => {
                        if (err2)
                            this.log.warn(`Reset drawer failed: ${errMsg(err2)}`);
                        setTimeout(() => swReset.updateCharacteristic(this.Characteristic.On, false), 300);
                    }, {});
                });
            }
            newAcc.context._last = { cycle: false, idle: false, code: null, state: 'READY' };
            newAcc.context._pulseMs = pulseMs;
            newAcc.context._interruptTimeoutFired = false;
            this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [newAcc]);
            this.accessories.set(uuid, newAcc);
            acc = newAcc;
        }
    }
    // ---------- polling ----------
    pollOnce(port, debug, pulseMs) {
        for (const acc of this.accessories.values()) {
            const id = String(acc.context.robotId ?? '');
            if (!id)
                continue;
            this.getStatus(id, port, (st) => {
                // Switch reflects current "cycle in progress" (specifically CycleNow switch)
                const switchSvc = acc.getServiceById(this.Service.Switch, 'CycleNow');
                if (switchSvc) {
                    switchSvc.updateCharacteristic(this.Characteristic.On, st.cycle);
                }
                // Optional Bonnet (advanced)
                const bonnetSvc = acc.getServiceById(this.Service.ContactSensor, 'Bonnet');
                if (bonnetSvc) {
                    bonnetSvc.updateCharacteristic(this.Characteristic.ContactSensorState, st.bonnet
                        ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
                        : this.Characteristic.ContactSensorState.CONTACT_DETECTED);
                }
                // Pinch is a critical alert
                const pinchSvc = acc.getServiceById(this.Service.ContactSensor, 'Pinch');
                if (pinchSvc) {
                    pinchSvc.updateCharacteristic(this.Characteristic.ContactSensorState, st.pinch
                        ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
                        : this.Characteristic.ContactSensorState.CONTACT_DETECTED);
                }
                // Offline occupancy (occupied = offline)
                const offlineSvc = acc.getServiceById(this.Service.OccupancySensor, 'Offline');
                if (offlineSvc) {
                    offlineSvc.updateCharacteristic(this.Characteristic.OccupancyDetected, st.offline
                        ? this.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
                        : this.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
                }
                // Fault bucket (any of: pinch/bonnet/paused/offline)
                const faultSvc = acc.getServiceById(this.Service.ContactSensor, 'CycleFault');
                if (faultSvc) {
                    const isFault = Boolean(st.pinch || st.bonnet || st.paused || st.offline);
                    faultSvc.updateCharacteristic(this.Characteristic.ContactSensorState, isFault
                        ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
                        : this.Characteristic.ContactSensorState.CONTACT_DETECTED);
                }
                // Cycle completed pulse
                const completedSvc = acc.getServiceById(this.Service.MotionSensor, 'CycleCompleted');
                const last = acc.context._last ?? { cycle: false, idle: false, code: null };
                if (last.cycle && !st.cycle && st.idle && completedSvc) {
                    const ms = Number(acc.context._pulseMs ?? pulseMs);
                    completedSvc.updateCharacteristic(this.Characteristic.MotionDetected, true);
                    setTimeout(() => completedSvc.updateCharacteristic(this.Characteristic.MotionDetected, false), ms);
                }
                // Drawer / Litter percentages (advanced)
                if (this.adv.drawerControl) {
                    const drawerHum = acc.getServiceById(this.Service.HumiditySensor, 'DrawerLevel');
                    const litterHum = acc.getServiceById(this.Service.HumiditySensor, 'LitterLevel');
                    if (drawerHum && typeof st.drawer_pct === 'number') {
                        drawerHum.updateCharacteristic(this.Characteristic.CurrentRelativeHumidity, clampNumber(st.drawer_pct, 0, 100));
                    }
                    if (litterHum && typeof st.litter_pct === 'number') {
                        litterHum.updateCharacteristic(this.Characteristic.CurrentRelativeHumidity, clampNumber(st.litter_pct, 0, 100));
                    }
                }
                // Reflect light state if provided
                const lightSvc = acc.getServiceById(this.Service.Switch, 'GlobeLight');
                if (lightSvc && typeof st.light_on === 'boolean') {
                    lightSvc.updateCharacteristic(this.Characteristic.On, Boolean(st.light_on));
                }
                // Interrupted-timeout pulse (advanced)
                const wantTimeout = Boolean(this.adv.interruptTimeoutEnabled) && Number(this.adv.interruptTimeoutMins ?? 0) > 0;
                const itSvc = acc.getServiceById(this.Service.MotionSensor, 'InterruptedTimeout');
                const curState = (st.state ?? (st.offline ? 'OFFLINE' : (st.cycle ? 'CLEANING' : (st.paused ? 'PAUSED' : 'READY'))));
                if (wantTimeout && itSvc) {
                    const now = Date.now();
                    const mins = Number(this.adv.interruptTimeoutMins);
                    if (curState === 'INTERRUPTED') {
                        if (!acc.context._interruptStartedAt) {
                            acc.context._interruptStartedAt = now;
                            acc.context._interruptTimeoutFired = false;
                        }
                        else if (!acc.context._interruptTimeoutFired &&
                            now - acc.context._interruptStartedAt >= mins * 60000) {
                            itSvc.updateCharacteristic(this.Characteristic.MotionDetected, true);
                            setTimeout(() => itSvc.updateCharacteristic(this.Characteristic.MotionDetected, false), Number(acc.context._pulseMs ?? pulseMs));
                            acc.context._interruptTimeoutFired = true;
                        }
                    }
                    else {
                        acc.context._interruptStartedAt = undefined;
                        acc.context._interruptTimeoutFired = false;
                    }
                }
                acc.context._last = { cycle: st.cycle, idle: st.idle, code: st.status_code, state: st.state };
                if (debug) {
                    const code = st.status_code ?? 'n/a';
                    const label = st.status_label ? `(${st.status_label})` : '';
                    this.log.info(`status: code=${code}${label} cycle=${st.cycle} idle=${st.idle} pinch=${st.pinch} ` +
                        `bonnet=${st.bonnet} home=${st.home} paused=${st.paused} offline=${st.offline}`);
                }
            });
        }
    }
    getStatus(id, port, cb) {
        this.request('GET', port, `/status/${id}`, (err, body) => {
            if (err) {
                const maybeDebug = this.log.debug;
                if (typeof maybeDebug === 'function') {
                    maybeDebug(`status error ${errMsg(err)}`);
                }
                return;
            }
            try {
                const p = JSON.parse(body ?? '{}');
                if (typeof p.id !== 'string')
                    return;
                const s = {
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
                    drawer_pct: typeof p.drawer_pct === 'number' ? p.drawer_pct : undefined,
                    litter_pct: typeof p.litter_pct === 'number' ? p.litter_pct : undefined,
                    light_on: typeof p.light_on === 'boolean' ? p.light_on : undefined,
                    state: (() => {
                        const st = p.state;
                        return st === 'READY' || st === 'CLEANING' || st === 'INTERRUPTED' || st === 'PAUSED' || st === 'OFFLINE'
                            ? st
                            : undefined;
                    })(),
                };
                cb(s);
            }
            catch {
                // swallow parse errors to avoid log spam
            }
        });
    }
    // ---------- http helper ----------
    request(method, port, pathName, cb, data) {
        const payload = data != null ? Buffer.from(JSON.stringify(data)) : undefined;
        const options = {
            host: '127.0.0.1',
            port,
            path: pathName,
            method,
            headers: payload
                ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
                : undefined,
            timeout: 8000,
        };
        const req = http.request(options, (res) => {
            let out = '';
            res.on('data', (c) => {
                out += c.toString();
            });
            res.on('end', () => cb(null, out));
        });
        req.on('error', (e) => cb(e));
        if (payload)
            req.write(payload);
        req.end();
    }
}
exports.LitterRobotPlatform = LitterRobotPlatform;
/* ---------- small helpers ---------- */
async function waitForHealthAdaptive(port, logFile, idleGraceMs = 45000, // how long to tolerate no new log lines
maxTotalMs = 900000) {
    const started = Date.now();
    let lastActivity = started;
    let lastSize = -1;
    while (Date.now() - started < maxTotalMs) {
        // Success path first
        const ok = await pingHealth(port).catch(() => false);
        if (ok)
            return true;
        // Track activity in bootstrap.log (if present)
        try {
            const stat = await fsp.stat(logFile);
            const size = stat.size;
            if (size !== lastSize) {
                lastSize = size;
                lastActivity = Date.now();
            }
            else if (Date.now() - stat.mtimeMs < 2000) {
                // mtime changed recently; count as activity
                lastActivity = Date.now();
            }
        }
        catch {
            /* file may not exist yet */
        }
        // If idle beyond grace after the first minute, give up
        if ((Date.now() - started) > 60000 && (Date.now() - lastActivity) > idleGraceMs) {
            return false;
        }
        await delay(500);
    }
    return false;
}
function clampNumber(n, min, max) {
    if (Number.isNaN(n))
        return min;
    return Math.max(min, Math.min(max, n));
}
async function waitForHealth(port, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const ok = await pingHealth(port).catch(() => false);
        if (ok)
            return true;
        await delay(300);
    }
    return false;
}
function pingHealth(port) {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 2000 }, (res) => {
            const ok = res.statusCode === 200;
            res.resume(); // drain
            resolve(ok);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}
function tailBootstrapLog(file, sink) {
    let stopped = false;
    let position = 0;
    let watcher = null;
    // prevent overlapping reads (fs.watch + poll can fire together)
    let inFlight = false;
    let pending = false;
    // simple de-dup: ignore the same line repeated within 2s
    let lastLine = '';
    let lastAt = 0;
    const emit = (ln) => {
        const now = Date.now();
        if (ln === lastLine && (now - lastAt) < 2000)
            return;
        lastLine = ln;
        lastAt = now;
        sink(ln);
    };
    const readNew = async () => {
        if (stopped)
            return;
        if (inFlight) {
            pending = true;
            return;
        }
        inFlight = true;
        try {
            const h = await fsp.open(file, 'r');
            try {
                const stat = await h.stat();
                // handle truncation or recreate
                if (stat.size < position)
                    position = 0;
                if (stat.size > position) {
                    const count = stat.size - position;
                    const buf = Buffer.allocUnsafe(count);
                    await h.read(buf, 0, count, position);
                    position = stat.size;
                    const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
                    for (const ln of lines)
                        emit(ln);
                }
            }
            finally {
                await h.close();
            }
        }
        catch {
            // file may not exist yet; ignore
        }
        finally {
            inFlight = false;
            if (pending) {
                pending = false;
                setTimeout(() => { void readNew(); }, 25);
            }
        }
    };
    // initial read & poll fallback
    void readNew();
    const timer = setInterval(() => { if (!stopped)
        void readNew(); }, 1000);
    try {
        watcher = fs.watch(path.dirname(file), (_evt, fname) => {
            if (stopped)
                return;
            if (!fname)
                return;
            const full = path.join(path.dirname(file), fname);
            if (full === file)
                void readNew();
        });
    }
    catch {
        // fs.watch may not be available; polling covers us
    }
    return () => {
        stopped = true;
        clearInterval(timer);
        try {
            watcher?.close();
        }
        catch { /* ignore */ }
    };
}
function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function errMsg(e) {
    return e instanceof Error ? e.message : String(e);
}
