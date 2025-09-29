export interface SidecarClientOptions {
    baseUrl: string;
    timeoutMs?: number;
    maxBackoffMs?: number;
}
export declare class SidecarClient {
    private baseUrl;
    private timeoutMs;
    private maxBackoffMs;
    constructor(opts: SidecarClientOptions);
    health(): Promise<boolean>;
    listRobots(): Promise<Record<string, unknown>[]>;
    status(serial: string): Promise<Record<string, unknown>>;
    cycle(serial: string): Promise<Record<string, unknown>>;
    private getJson;
    private postJson;
}
