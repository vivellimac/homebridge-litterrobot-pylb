import { PlatformAccessory, API, Logging, PlatformConfig, Service, Characteristic, DynamicPlatformPlugin } from 'homebridge';
type LastSnapshot = {
    cycle: boolean;
    idle: boolean;
    code: string | null;
    state?: 'READY' | 'CLEANING' | 'INTERRUPTED' | 'PAUSED' | 'OFFLINE';
};
type AccessoryContext = {
    robotId: string;
    _last: LastSnapshot;
    _pulseMs: number;
    _interruptStartedAt?: number;
    _interruptTimeoutFired?: boolean;
};
export declare class LitterRobotPlatform implements DynamicPlatformPlugin {
    readonly log: Logging;
    readonly config: PlatformConfig;
    readonly api: API;
    private readonly hap;
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    private readonly accessories;
    private poll?;
    private py;
    private tailStop?;
    private adv;
    private runtimePort;
    private runtimeWorkdir;
    private runtimeDebug;
    constructor(log: Logging, config: PlatformConfig, api: API);
    configureAccessory(acc: PlatformAccessory<AccessoryContext>): void;
    private start;
    private stop;
    private loginAndBegin;
    private upsertRobot;
    private pollOnce;
    private getStatus;
    private request;
}
export {};
