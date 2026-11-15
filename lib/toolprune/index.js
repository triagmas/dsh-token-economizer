/**
 * Tool pruning: stop paying, on every request, for tool definitions a repository never
 * uses.
 *
 * Portions derived from microsoft/TokenEconomizer (Apache-2.0), commit
 * 7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0.
 * Upstream package: `tokeneconomizer/toolprune/` (`__init__.py` exports
 * `PROTECTED_TOOLS`, `INAPPLICABLE_TOOLS`, the stage and the Codex controller).
 *
 * DSH layout:
 *   - `stats.ts`  -- folds observed sessions into `tools.json` rows: available vs called,
 *                    successes/failures, description-token estimates, last use, and the
 *                    loaded-but-unused evidence the policy needs.
 *   - `policy.ts` -- the evidence rules, the protected work surface, the four pruning
 *                    modes, restore/mark transitions and the periodic re-audit helper.
 *
 * Both modules are pure: they mutate the passed `ToolsFile` and never perform I/O.
 */
export * from './stats.js';
export * from './policy.js';
export * from './glob.js';
