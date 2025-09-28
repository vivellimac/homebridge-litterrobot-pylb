import type { Logger } from 'homebridge';

let root: Logger | null = null;

export const initRootLogger = (l: Logger) => { if (!root) root = l; };

export const getLogger = (ns?: string): Logger => {
  if (!root) throw new Error('Logger not initialized');
  if (!ns) return root;
  return Object.assign(Object.create(root), {
    info: (...a: any[]) => root!.info(`[${ns}]`, ...a),
    warn: (...a: any[]) => root!.warn(`[${ns}]`, ...a),
    error: (...a: any[]) => root!.error(`[${ns}]`, ...a),
    debug: (...a: any[]) => (root as any).debug?.(`[${ns}]`, ...a),
  });
};
