import { expect, test } from "vitest";
import { isPublicAddress } from "./address-policy.ts";

test.each([
	"140.82.121.4", // github.com
	"1.1.1.1",
	"8.8.8.8",
	"2606:4700:4700::1111",
	"2a00:1450:4001:81c::200e",
	"::ffff:140.82.121.4",
])("%s is public", (address) => {
	expect(isPublicAddress(address)).toBe(true);
});

test.each([
	["127.0.0.1", "loopback"],
	["127.255.255.254", "loopback"],
	["10.1.2.3", "private"],
	["172.16.0.1", "private"],
	["172.31.255.255", "private"],
	["192.168.0.63", "private (the dev machine)"],
	["169.254.169.254", "cloud metadata"],
	["100.64.0.1", "carrier-grade NAT"],
	["0.0.0.0", "unspecified"],
	["224.0.0.1", "multicast"],
	["255.255.255.255", "broadcast"],
	["192.0.2.1", "documentation"],
	["198.18.0.1", "benchmarking"],
	["::1", "IPv6 loopback"],
	["::", "IPv6 unspecified"],
	["fe80::1", "IPv6 link-local"],
	["fd00::1", "IPv6 unique local"],
	["fc00::1", "IPv6 unique local"],
	["ff02::1", "IPv6 multicast"],
	["2001:db8::1", "IPv6 documentation"],
	["2002:c0a8:0001::1", "6to4 wrapping 192.168.0.1"],
	["64:ff9b::7f00:1", "NAT64 wrapping 127.0.0.1"],
	["2001:0:4136:e378::1", "Teredo"],
	["::ffff:127.0.0.1", "IPv4-mapped loopback"],
	["::ffff:7f00:1", "IPv4-mapped loopback, hex form"],
	["::ffff:192.168.1.1", "IPv4-mapped private"],
	["::127.0.0.1", "IPv4-compatible (deprecated)"],
	["not-an-ip", "not an address"],
	["", "empty"],
])("%s is blocked (%s)", (address) => {
	expect(isPublicAddress(address)).toBe(false);
});
