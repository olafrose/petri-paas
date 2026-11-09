import {
	Caveat,
	IBM_Plex_Mono,
	IBM_Plex_Sans,
	Kalam,
	Patrick_Hand,
} from "next/font/google";

/*
 * Candidate fonts for the style guide (task 4.1). next/font downloads them
 * at build time and serves them from this app: browsers never contact
 * Google. All are under the SIL Open Font License. Once the owner has
 * chosen, the others go.
 */

export const caveat = Caveat({
	subsets: ["latin"],
	weight: ["400", "700"],
	variable: "--font-caveat",
	display: "swap",
});

export const kalam = Kalam({
	subsets: ["latin"],
	weight: ["400", "700"],
	variable: "--font-kalam",
	display: "swap",
});

export const patrickHand = Patrick_Hand({
	subsets: ["latin"],
	weight: "400",
	variable: "--font-patrick-hand",
	display: "swap",
});

export const plexSans = IBM_Plex_Sans({
	subsets: ["latin"],
	weight: ["400", "500", "600"],
	variable: "--font-plex-sans",
	display: "swap",
});

export const plexMono = IBM_Plex_Mono({
	subsets: ["latin"],
	weight: ["400", "500"],
	variable: "--font-plex-mono",
	display: "swap",
});

/** All candidates' CSS variables, for the root element. */
export const fontVariables = [caveat, kalam, patrickHand, plexSans, plexMono]
	.map((font) => font.variable)
	.join(" ");
