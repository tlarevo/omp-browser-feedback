export function generateBrowserBrokerToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

export function bearerTokenFromRequest(request: Request): string | undefined {
	const header = request.headers.get("authorization");
	if (!header?.startsWith("Bearer ")) return undefined;
	const token = header.slice("Bearer ".length).trim();
	return token.length > 0 ? token : undefined;
}

export function isAuthorizedRequest(
	request: Request,
	authToken: string,
): boolean {
	return bearerTokenFromRequest(request) === authToken;
}

export function isAuthorizedBrowserRequest(
	request: Request,
	validateBrowserCapability: (capabilityToken: string) => boolean,
): boolean {
	const capabilityToken = bearerTokenFromRequest(request);
	return (
		capabilityToken !== undefined && validateBrowserCapability(capabilityToken)
	);
}
