// ── Component interface ───────────────────────────────────────
//
// Layer 3 of the Component System Proposal: micro components
// that own their DOM subtrees with lifecycle hooks.
//
// Each component:
//   1. Creates its DOM in the constructor
//   2. Attaches to a container via mount()
//   3. Re-renders via update(props)
//   4. Cleans up via destroy()
//
// No virtual DOM — direct DOM manipulation with lifecycle hooks.

/** Generic component interface. P is the props type. */
export interface Component<P = Record<string, unknown>> {
  /** The component's root DOM element (created in constructor). */
  readonly el: HTMLElement;

  /** Attach this component's root element to a container. */
  mount(container: HTMLElement): void;

  /** Re-render with new props. */
  update(props: P): void;

  /** Remove from DOM and clean up event listeners, timers, etc. */
  destroy(): void;
}
