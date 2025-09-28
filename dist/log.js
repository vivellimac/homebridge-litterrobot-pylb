"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLogger = exports.initRootLogger = void 0;
/** Singleton root logger to avoid duplicate instances */
let root = null;
/** Initialize once with Homebridge's logger */
const initRootLogger = (l) => { if (!root) root = l; };
exports.initRootLogger = initRootLogger;
/** Namespaced child logger (prefixes with [ns]) */
const getLogger = (ns) => {
  if (!root) throw new Error('Logger not initialized');
  if (!ns) return root;
  return Object.assign(Object.create(root), {
    info: (...a) => root.info(`[${ns}]`, ...a),
    warn: (...a) => root.warn(`[${ns}]`, ...a),
    error: (...a) => root.error(`[${ns}]`, ...a),
    debug: (...a) => (root.debug ? root.debug(`[${ns}]`, ...a) : undefined),
  });
};
exports.getLogger = getLogger;
