/**
 * Type-level tests for the consumer binding contract. No runtime component -
 * `npx tsc --noEmit` is the assertion.
 *
 * The negative cases carry `@ts-expect-error`, so this file fails the typecheck
 * in both directions: if the contract stops rejecting a bad `Env`, the
 * suppression becomes unused and TypeScript reports it. Weakening
 * `AuthAgentBindings` therefore breaks the build here rather than silently
 * letting a misconfigured install through.
 *
 * The namespaces are parameterised by the concrete agent class because that is
 * what `wrangler types` emits in a consumer project. Testing with
 * `DurableObjectNamespace<never>` would be misleading: `never` fails the
 * contravariant check that a real class passes.
 */
import type { AuthAgent } from './agent.js';
import type { AssertAuthAgentEnv } from './bindings.js';

/**
 * This repository's own `Env` is a consumer of the contract like any other. If
 * a binding is added to the agent without being added to the shipped wrangler
 * configuration, this fails the agent typecheck rather than someone's install.
 *
 * It lives here rather than in `bindings.ts` so it stays out of the published
 * declarations, where it would be evaluated against the consumer's `Env` and
 * report an error inside `node_modules` - and be silently skipped anyway by the
 * `skipLibCheck: true` that most Workers projects set.
 */
export type _SelfCheck = AssertAuthAgentEnv<Env>;

/** The one required binding and nothing else. */
interface ConsumerMinimal {
	AuthAgent: DurableObjectNamespace<AuthAgent>;
}
export type _Minimal = AssertAuthAgentEnv<ConsumerMinimal>;

/** A fuller deployment, with the common optional bindings declared. */
interface ConsumerFull {
	AuthAgent: DurableObjectNamespace<AuthAgent>;
	AUTH_EVENTS: AnalyticsEngineDataset;
	AI: Ai;
	EMAIL: SendEmail;
	EMAIL_FROM: string;
	TRUSTED_ORIGINS: string;
	WAE_DATASET: string;
	DEMO_MODE: 'true';
}
export type _Full = AssertAuthAgentEnv<ConsumerFull>;

/**
 * No Analytics Engine dataset. VALID: the binding is optional because
 * Analytics Engine is an account-level opt-in with no API, so requiring it
 * made a first `wrangler deploy` impossible on an account that never enabled
 * it (`no_access_to_analytics_engine`, code 10089). Writes are skipped and
 * nothing else changes.
 */
interface ConsumerNoEvents {
	AuthAgent: DurableObjectNamespace<AuthAgent>;
	AI: Ai;
}
export type _NoEvents = AssertAuthAgentEnv<ConsumerNoEvents>;

/** Bound the right name to the wrong resource - still rejected when present. */
interface ConsumerWrongType {
	AuthAgent: DurableObjectNamespace<AuthAgent>;
	AUTH_EVENTS: D1Database;
}
// @ts-expect-error AUTH_EVENTS must be an AnalyticsEngineDataset.
export type _WrongType = AssertAuthAgentEnv<ConsumerWrongType>;

/** Optional bindings are still type-checked when present. */
interface ConsumerWrongOptional {
	AuthAgent: DurableObjectNamespace<AuthAgent>;
	AUTH_EVENTS: AnalyticsEngineDataset;
	TRUSTED_ORIGINS: number;
}
// @ts-expect-error TRUSTED_ORIGINS is a comma-separated string.
export type _WrongOptional = AssertAuthAgentEnv<ConsumerWrongOptional>;
