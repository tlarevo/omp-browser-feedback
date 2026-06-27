export const DEFAULT_BROWSER_BROKER_HOST = "127.0.0.1";
export const PREFERRED_BROWSER_BROKER_PORT = 4317;
export const DEFAULT_BROWSER_BROKER_PORT_RANGE = "4317-4337";

export interface BrowserBrokerPortRange {
	start: number;
	end: number;
}

export function parsePortRange(value: string): BrowserBrokerPortRange {
	const [startText, endText] = value.split("-", 2);
	const start = Number(startText);
	const end = Number(endText);
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65_535 || start > end) {
		throw new Error(`Invalid browser broker port range: ${value}`);
	}
	return { start, end };
}

export function portsInRange(range: BrowserBrokerPortRange): number[] {
	const ports: number[] = [];
	for (let port = range.start; port <= range.end; port++) {
		ports.push(port);
	}
	return ports;
}
