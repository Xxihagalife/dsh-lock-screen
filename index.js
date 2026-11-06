/**
 * Host half of the lock-screen bundle.
 *
 * The whole lock is a Client-side privacy gate: an opaque, frame-wide overlay
 * plus a password check performed in the page, so the Host half only needs to
 * exist for the bundle row. Keeping it empty is deliberate — no session data,
 * no Host preference, and no credential ever leaves the browser profile.
 */
export function apply() {}
