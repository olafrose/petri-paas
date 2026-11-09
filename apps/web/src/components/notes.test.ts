import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Notes } from "./notes.tsx";

const render = (markdown: string) =>
	renderToStaticMarkup(createElement(Notes, { markdown }));

describe("Notes", () => {
	test("renders Markdown, with task lists and tables", () => {
		const html = render(
			"## Tried\n\n- [x] **bold** idea\n- [ ] next\n\n| a | b |\n|---|---|\n| 1 | 2 |",
		);
		expect(html).toContain("<h2>Tried</h2>");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
		expect(html).toContain("<td>1</td>");
	});

	test("shows raw HTML as text", () => {
		const html = render(
			'Hi <script>alert(1)</script> <img src=x onerror="alert(1)"> <b>there</b>\n\n<div onclick="x()">block</div>',
		);
		expect(html).not.toMatch(/<(script|img|b|div onclick)\b/);
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("&lt;div onclick=&quot;x()&quot;&gt;");
	});

	test("drops unsafe link targets and opens links in a new tab", () => {
		const html = render(
			"[bad](javascript:alert(1)) [data](data:text/html,x) [good](https://example.com)",
		);
		expect(html).not.toContain("javascript:");
		expect(html).not.toContain("data:text/html");
		expect(html).toContain(
			'<a href="https://example.com" target="_blank" rel="noopener noreferrer">good</a>',
		);
	});
});
