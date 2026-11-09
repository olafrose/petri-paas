import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./notes.module.css";

/**
 * A project's lab notes, written in Markdown. Rendered on the server, so
 * no JavaScript reaches the browser. Raw HTML in the notes is shown as
 * text, never interpreted, and unsafe link targets (`javascript:`, ...)
 * are dropped.
 */
export function Notes({ markdown }: { markdown: string }) {
	return (
		<div className={styles.notes}>
			<Markdown
				remarkPlugins={[remarkGfm]}
				components={{
					a: ({ node: _node, ...props }) => (
						<a {...props} target="_blank" rel="noopener noreferrer" />
					),
				}}
			>
				{markdown}
			</Markdown>
		</div>
	);
}
