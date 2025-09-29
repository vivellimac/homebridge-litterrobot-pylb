"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLogger = exports.initRootLogger = void 0;
let root = null;
const initRootLogger = (l) => {
    if (!root)
        root = l;
};
exports.initRootLogger = initRootLogger;
const tail = (params) => params.length
    ? ' ' +
        params
            .map((p) => (typeof p === 'string' ? p : (() => { try {
            return JSON.stringify(p);
        }
        catch {
            return String(p);
        } })()))
            .join(' ')
    : '';
const getLogger = (ns) => {
    if (!root) {
        throw new Error('Logger not initialized');
    }
    if (!ns) {
        return root;
    }
    const base = root;
    const prefix = `[${ns}] `;
    const info = (message, ...parameters) => base.info(`${prefix}${message}${tail(parameters)}`);
    const warn = (message, ...parameters) => base.warn(`${prefix}${message}${tail(parameters)}`);
    const error = (message, ...parameters) => base.error(`${prefix}${message}${tail(parameters)}`);
    const success = (message, ...parameters) => base.success(`${prefix}${message}${tail(parameters)}`);
    const log = (level, message, ...parameters) => base.log(level, `${prefix}${message}${tail(parameters)}`);
    // Always provide a debug; fall back to info if base.debug isn't present at runtime
    const debugImpl = typeof base.debug === 'function' ? base.debug.bind(base) : base.info.bind(base);
    const debug = (message, ...parameters) => debugImpl(`${prefix}${message}${tail(parameters)}`);
    // Return a concrete Logger with required methods
    const logger = { info, warn, error, success, log, debug };
    return logger;
};
exports.getLogger = getLogger;
