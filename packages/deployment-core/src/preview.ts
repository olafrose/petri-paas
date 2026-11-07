/**
 * Where a deployment's preview is served: its subdomain under the host of
 * the preview base URL, with that URL's scheme and port. E.g. base
 * `https://app.example.com` and subdomain `demo-main` give
 * `https://demo-main.app.example.com/`.
 */
export function previewUrl(baseUrl: string, subdomain: string): string {
	const url = new URL(baseUrl);
	url.hostname = previewHostname(baseUrl, subdomain);
	url.pathname = "/";
	return url.toString();
}

/** The hostname the edge proxy routes for a deployment. */
export function previewHostname(baseUrl: string, subdomain: string): string {
	return `${subdomain}.${new URL(baseUrl).hostname}`.toLowerCase();
}
