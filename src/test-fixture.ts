// ── Test fixture for read-block rendering ────────────────────
//
// This file exists solely to test how the read tool renderer
// displays small vs. large file results.  Edit freely — it's
// not part of the real application.

/** A simple greeter. */
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}

/** Returns the current timestamp. */
export function now(): number {
  return Date.now();
}
