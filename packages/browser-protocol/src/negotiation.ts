/**
 * Protocol version negotiation.
 *
 * Two peers each declare a supported range [min, max].  Negotiation picks
 * the highest version present in both ranges.  When no overlap exists the
 * result is `undefined` and the caller MUST return
 * `protocol_version_unsupported` with both ranges.
 */

/** Generic version range — accepts any integer, not just current versions. */
export interface VersionRange {
	min: number;
	max: number;
}

/**
 * Negotiate the highest shared protocol version from two ranges.
 * Returns `undefined` when no version overlaps — the caller MUST reject
 * the connection with `protocol_version_unsupported`.
 *
 * Returns `number` (not `BrowserProtocolVersion`) because the algorithm is
 * generic and future versions may be added.  Callers narrow to their
 * supported range after checking overlap.
 */
export function negotiateProtocolVersion(
	local: VersionRange,
	remote: VersionRange,
): number | undefined {
	const floor = Math.max(local.min, remote.min);
	const ceiling = Math.min(local.max, remote.max);
	if (floor > ceiling) return undefined;
	return ceiling;
}

/**
 * Check whether two version ranges overlap at all.
 */
export function versionsOverlap(a: VersionRange, b: VersionRange): boolean {
	return Math.max(a.min, b.min) <= Math.min(a.max, b.max);
}
