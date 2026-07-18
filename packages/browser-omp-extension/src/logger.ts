/**
 * Minimal scoped logger for the browser-omp-extension.
 * Prefixes every line so messages are greppable and distinguishable
 * from core OMP output.
 */
const TAG = "[browser-feedback]";

export function logInfo(...args: unknown[]): void {
	console.log(TAG, ...args);
}

export function logWarn(...args: unknown[]): void {
	console.warn(TAG, ...args);
}

export function logError(...args: unknown[]): void {
	console.error(TAG, ...args);
}
