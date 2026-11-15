/**
 * Compile-time contract test, executed by `tsc --noEmit` (excluded from the
 * publish build). The @ts-expect-error negatives fail the typecheck in BOTH
 * directions: weakening the contract makes a suppression unused, which
 * TypeScript reports.
 */
import type { AssertStorageAgentEnv } from './bindings.js';

// This repository's own generated Env satisfies the contract.
type _SelfCheck = AssertStorageAgentEnv<Env>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNamespace = DurableObjectNamespace<any>;

// The minimal correct deployment: the two Durable Object namespaces.
type _Minimal = AssertStorageAgentEnv<{
	StorageAgent: AnyNamespace;
	StorageBucket: AnyNamespace;
}>;

// A fully configured deployment.
type _Full = AssertStorageAgentEnv<{
	StorageAgent: AnyNamespace;
	StorageBucket: AnyNamespace;
	BUCKET: R2Bucket;
	AUTH_AGENT: Fetcher;
	TRUSTED_ORIGINS: string;
	STORAGE_SERVE_DOMAIN: string;
	SENTRY_DSN: string;
	SENTRY_ENV: string;
	EXPOSE_OPERATOR_API: 'true';
}>;

// @ts-expect-error - the orchestrator namespace is required.
type _MissingAgent = AssertStorageAgentEnv<{ StorageBucket: AnyNamespace }>;

// @ts-expect-error - the per-bucket index namespace is required.
type _MissingBucket = AssertStorageAgentEnv<{ StorageAgent: AnyNamespace }>;

// @ts-expect-error - BUCKET must be an R2 bucket, not a Fetcher.
type _WrongBucket = AssertStorageAgentEnv<{
	StorageAgent: AnyNamespace;
	StorageBucket: AnyNamespace;
	BUCKET: Fetcher;
}>;

// @ts-expect-error - vars are strings.
type _WrongVar = AssertStorageAgentEnv<{
	StorageAgent: AnyNamespace;
	StorageBucket: AnyNamespace;
	TRUSTED_ORIGINS: number;
}>;

export type {};
