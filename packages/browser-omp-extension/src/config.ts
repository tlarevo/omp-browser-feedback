import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface BrowserFeedbackConfig {
	autoRun: boolean;
	portRange?: string;
}

const DEFAULT_CONFIG: BrowserFeedbackConfig = { autoRun: false };

function configPath(): string {
	return path.join(Bun.env.HOME ?? "~", ".omp", "browser-feedback.json");
}

export async function readConfig(): Promise<BrowserFeedbackConfig> {
	try {
		const raw = await Bun.file(configPath()).json();
		return { ...DEFAULT_CONFIG, ...(raw as Partial<BrowserFeedbackConfig>) };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export async function writeConfig(
	config: Partial<BrowserFeedbackConfig>,
): Promise<void> {
	const current = await readConfig();
	const next = { ...current, ...config };
	await fs.mkdir(path.dirname(configPath()), { recursive: true });
	await Bun.write(configPath(), JSON.stringify(next, null, 2));
}
