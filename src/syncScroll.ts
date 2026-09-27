import {EditorView} from "@codemirror/view";

/** Share one synchronizer between the two editors of a file. */
export function createHorizontalScrollSync() {
	const expected = new WeakMap<HTMLElement, number>();
	const previous = new WeakMap<HTMLElement, number>();

	return (source: HTMLElement, target: HTMLElement, enabled: boolean): void => {
		const left = source.scrollLeft;
		const last = previous.get(source) ?? 0;
		previous.set(source, left);
		const pending = expected.get(source);
		expected.delete(source);
		// Ignore vertical scrolling and events caused by our own scroll writes.
		if (!enabled || left === last || left === pending) return;
		if (target.scrollLeft === left) return;
		target.scrollLeft = left;
		// Read back the actual offset: the other pane may be shorter and clamp it.
		expected.set(target, target.scrollLeft);
	};
}

/** CodeMirror owns the listener and removes it when the editor is destroyed. */
export function synchronizedScroll(
	sync: ReturnType<typeof createHorizontalScrollSync>,
	getSibling: () => EditorView | undefined,
	isEnabled: () => boolean,
) {
	return EditorView.domEventHandlers({
		scroll(event, view) {
			const sibling = getSibling();
			if (event.target === view.scrollDOM && sibling) {
				sync(view.scrollDOM, sibling.scrollDOM, isEnabled());
			}
		},
	});
}
