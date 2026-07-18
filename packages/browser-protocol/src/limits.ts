export const BROWSER_FEEDBACK_LIMITS = {
	/** Max user note length, measured in Unicode code points. */
	maxNoteLength: 8_000,
	/** Max DOM-derived element text length, measured in Unicode code points. */
	maxElementTextLength: 4_000,
	/** Max element outer-HTML length, measured in Unicode code points. */
	maxOuterHtmlLength: 20_000,
	/** Max number of captured attribute entries. */
	maxAttributeCount: 80,
	/** Max number of captured computed-style entries. */
	maxComputedStyleCount: 80,
	/** Max screenshot binary size, measured in UTF-8/raw bytes. */
	maxScreenshotBytes: 10 * 1024 * 1024,
	maxConsoleEntries: 20,
	maxConsoleEntryBytes: 8 * 1024,
	maxConsoleSectionBytes: 64 * 1024,
} as const;
