import { Caveat } from "next/font/google";

/*
 * The handwritten accent font (task 4.1: chosen by the owner). next/font
 * downloads it at build time and serves it from this app: browsers never
 * contact Google. SIL Open Font License.
 */
export const caveat = Caveat({
	subsets: ["latin"],
	weight: ["400", "700"],
	variable: "--font-caveat",
	display: "swap",
});
