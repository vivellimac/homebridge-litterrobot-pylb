import { PlatformAccessory, API, Logging, PlatformConfig, Service, Characteristic, DynamicPlatformPlugin } from 'homebridge';
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
