"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SidecarClient = void 0;
function hasOk(x) {
    return typeof x === 'object' && x !== null && 'ok' in x;
}
class SidecarClient {
    constructor(opts) {
        this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
        this.timeoutMs = opts.timeoutMs ?? 5000;
        this.maxBackoffMs = opts.maxBackoffMs ?? 30000;
    }
    async health() {
        try {
            const r = await this.getJson('/health');
            return hasOk(r) ? Boolean(r.ok) : false;
        }
        catch {
            return false;
        }
    }
    async listRobots() {
        const r = await this.getJson('/robots');
        return Array.isArray(r) ? r : [];
    }
    async status(serial) {
        const r = await this.getJson(`/status/${encodeURIComponent(serial)}`);
        return (typeof r === 'object' && r !== null) ? r : {};
    }
    async cycle(serial) {
        const r = await this.postJson('/cycle', { serial });
        return (typeof r === 'object' && r !== null) ? r : {};
    }
    // ---- internal
    async getJson(path) {
        const ctrl = new AbortController();
        const id = setTimeout(() => ctrl.abort(), this.timeoutMs);
        try {
            const res = await fetch(this.baseUrl + path, { signal: ctrl.signal });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            const ct = res.headers.get('content-type') || '';
            return ct.includes('application/json') ? res.json() : res.text();
        }
        finally {
            clearTimeout(id);
        }
    }
    async postJson(path, body) {
        const ctrl = new AbortController();
        const id = setTimeout(() => ctrl.abort(), this.timeoutMs);
        try {
            const res = await fetch(this.baseUrl + path, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            const ct = res.headers.get('content-type') || '';
            return ct.includes('application/json') ? res.json() : res.text();
        }
        finally {
            clearTimeout(id);
        }
    }
}
exports.SidecarClient = SidecarClient;
