import { BlockList, isIP } from "node:net";

/*
 * Which addresses a source fetch may connect to: public internet only.
 * Everything private, local, reserved or special-purpose is blocked, so
 * a repository URL can't be used to reach the homelab (SSRF).
 */

const blocked = new BlockList();

for (const [network, prefix] of [
	["0.0.0.0", 8], // "this network"
	["10.0.0.0", 8], // private
	["100.64.0.0", 10], // carrier-grade NAT
	["127.0.0.0", 8], // loopback
	["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
	["172.16.0.0", 12], // private
	["192.0.0.0", 24], // IETF protocol assignments
	["192.0.2.0", 24], // documentation
	["192.88.99.0", 24], // 6to4 relay
	["192.168.0.0", 16], // private
	["198.18.0.0", 15], // benchmarking
	["198.51.100.0", 24], // documentation
	["203.0.113.0", 24], // documentation
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved, incl. broadcast
] as const) {
	blocked.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
	["::", 128], // unspecified
	["::1", 128], // loopback
	["64:ff9b::", 96], // NAT64 (embeds IPv4)
	["64:ff9b:1::", 48], // local NAT64
	["100::", 64], // discard
	["2001::", 23], // IETF special purpose, incl. Teredo
	["2001:db8::", 32], // documentation
	["2002::", 16], // 6to4 (embeds IPv4)
	["fc00::", 7], // unique local
	["fe80::", 10], // link-local
	["ff00::", 8], // multicast
] as const) {
	blocked.addSubnet(network, prefix, "ipv6");
}

/** The IPv4 address inside an IPv4-mapped (::ffff:a.b.c.d) IPv6 address. */
function embeddedIPv4(address: string): string | null {
	const match = /^::ffff:(?:0+:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	if (match?.[1]) return match[1];
	const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
	if (hex?.[1] && hex[2]) {
		const high = Number.parseInt(hex[1], 16);
		const low = Number.parseInt(hex[2], 16);
		return [high >> 8, high & 255, low >> 8, low & 255].join(".");
	}
	return null;
}

/** True only for addresses on the public internet. */
export function isPublicAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 0) return false;
	if (family === 6) {
		const v4 = embeddedIPv4(address);
		if (v4) return isPublicAddress(v4);
		// Only global unicast (2000::/3) is public; everything else is not.
		const first = Number.parseInt(address.split(":")[0] || "0", 16);
		if (Number.isNaN(first) || first < 0x2000 || first > 0x3fff) return false;
		return !blocked.check(address, "ipv6");
	}
	return !blocked.check(address, "ipv4");
}
