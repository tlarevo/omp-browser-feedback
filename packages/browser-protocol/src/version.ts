export const BROWSER_BROKER_SERVICE = "omp-browser-broker";

/** Lowest protocol version this build can still speak. */
export const BROWSER_PROTOCOL_MIN_VERSION = 1;
/** Highest protocol version this build supports (the current version). */
export const BROWSER_PROTOCOL_VERSION = 2;
/** Every protocol version this build can speak, ascending. */
export const BROWSER_PROTOCOL_VERSIONS = [1, 2] as const;
