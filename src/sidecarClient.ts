export interface SidecarClientOptions {
  baseUrl: string;          // e.g. http://127.0.0.1:8765
  timeoutMs?: number;
  maxBackoffMs?: number;
}

function hasOk(x: unknown): x is { ok: unknown } {
  return typeof x === 'object' && x !== null && 'ok' in x;
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
      return hasOk(r) ? Boolean(r.ok) : false;
    } catch {
      return false;
    }
  }

  async listRobots(): Promise<Record<string, unknown>[]> {
    const r = await this.getJson('/robots');
    return Array.isArray(r) ? (r as Record<string, unknown>[]) : [];
  }

  async status(serial: string): Promise<Record<string, unknown>> {
    const r = await this.getJson(`/status/${encodeURIComponent(serial)}`);
    return (typeof r === 'object' && r !== null) ? (r as Record<string, unknown>) : {};
  }

  async cycle(serial: string): Promise<Record<string, unknown>> {
    const r = await this.postJson('/cycle', { serial });
    return (typeof r === 'object' && r !== null) ? (r as Record<string, unknown>) : {};
  }

  // ---- internal

  private async getJson(path: string): Promise<unknown> {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get('content-type') || '';
      return ct.includes('application/json') ? res.json() : res.text();
    } finally {
      clearTimeout(id);
    }
  }

  private async postJson(path: string, body: Record<string, unknown>): Promise<unknown> {
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
      const ct = res.headers.get('content-type') || '';
      return ct.includes('application/json') ? res.json() : res.text();
    } finally {
      clearTimeout(id);
    }
  }
}
