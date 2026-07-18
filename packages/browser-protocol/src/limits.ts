export const BROWSER_FEEDBACK_LIMITS = {
	maxNoteLength: 8_000,
	maxElementTextLength: 4_000,
	maxOuterHtmlLength: 20_000,
	maxAttributeCount: 80,
	maxComputedStyleCount: 80,
	maxScreenshotBytes: 10 * 1024 * 1024,
	maxConsoleEntries: 20,
	maxConsoleEntryBytes: 8 * 1024,
	maxConsoleSectionBytes: 64 * 1024,
} as const;
