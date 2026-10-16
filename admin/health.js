// What the app last saw of Shopify and Exact, for the status in the NAS admin panel.
// Updated by the catch-up rounds in index.js.
export const health = {
    startedAt: new Date().toISOString(),
    lastRound: null, // when the last catch-up round finished
    shopify: { ok: null, at: null, error: null },
    exact: { ok: null, at: null, error: null },
};

export function markOk(part, at = new Date()) {
    health[part] = { ok: true, at: at.toISOString(), error: null };
}

export function markFailed(part, error, at = new Date()) {
    health[part] = { ok: false, at: at.toISOString(), error: String(error?.message || error).slice(0, 300) };
}
