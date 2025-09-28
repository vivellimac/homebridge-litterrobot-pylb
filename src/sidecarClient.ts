/* eslint-disable @typescript-eslint/no-unused-vars */
type Json = Record<string, unknown>;

export interface SidecarClientOptions {
  baseUrl: string;          // e.g. http://127.0.0.1:8765 or http://host:port
  timeoutMs?: number;       // per request
  maxBackoffMs?: number;    // cap for exponential backoff
}

export class SidecarClient {
  private baseUrl: string;
  private timeoutMs: number;
  private maxBackoffMs: number;

  constructor(opts: SidecarClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30000;
  }

  async health(): Promise<boolean> {
    try {
      const r = await this.getJson('/health');
      return Boolean((r as Json).ok);
    } catch {
      return false;
    }
  }

  async listRobots(): Promise<Json[]> {
    const r = await this.getJson('/robots');
    return Array.isArray(r) ? (r as Json[]) : [];
  }

  async status(serial: string): Promise<Json> {
    return this.getJson(`/status/${encodeURIComponent(serial)}`);
  }

  async cycle(serial: string): Promise<Json> {
    return this.postJson('/cycle', { serial });
  }

  // ---- internal

  private async getJson(path: string): Promise<Json | unknown> {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.headers.get('content-type')?.includes('application/json')
        ? res.json()
        : res.text();
    } finally {
      clearTimeout(id);
    }
  }

  private async postJson(path: string, body: Json): Promise<Json | unknown> {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.headers.get('content-type')?.includes('application/json')
        ? res.json()
        : res.text();
    } finally {
      clearTimeout(id);
    }
  }
}
