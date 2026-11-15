import * as Sentry from '@sentry/cloudflare';
import { getAgentByName, routeAgentRequest } from 'agents';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { gateOperatorRoutes } from './route-access.js';
import { AuthAgent as AuthAgentBase } from './agent.js';
import { projectIdSchema } from './schemas.js';

export type {
	AgentChatReply,
	AgentChatMessage,
	AuthActivityEvent,
	AuthAgentState,
	AuthAnalytics,
	AuthOverview,
	ConsoleMe,
	ConsoleOrgMembership,
	ConsolePendingInvitation,
} from './agent.js';
export type { AssertAuthAgentEnv, AuthAgentBindings } from './bindings.js';

const sentryOptions = (env: Env) => ({
	dsn: env.SENTRY_DSN,
	environment: env.SENTRY_ENV,
	tracesSampleRate: 0.1,
	enableRpcTracePropagation: true,
});

export const AuthAgent = Sentry.instrumentDurableObjectWithSentry(sentryOptions, AuthAgentBase);

/**
 * Auth service for Frostbase. Each project gets its own AuthAgent - a
 * SQLite-backed Durable Object running Better Auth with realtime state sync.
 *
 * Reached two ways:
 * - Service binding fetch from the dashboard worker (AUTH_AGENT binding)
 * - Directly over HTTP/WebSocket at /agents/auth-agent/<projectId>/...
 */
class AuthService extends WorkerEntrypoint<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/health') {
			return Response.json({ service: 'auth-agent', status: 'ok' });
		}

		// Everything below this line is either an operator route or a
		// control-plane one, and the package cannot assume a console guard sits
		// in front of it: the documented consumer install mounts this handler on
		// their own PUBLIC Worker. Closed unless the deployment says otherwise
		// (src/route-access.ts). A no-op here, where EXPOSE_OPERATOR_API is on a
		// worker that has no public hostname to begin with.
		const gated = gateOperatorRoutes(url, this.env);
		if (gated) return gated;

		// Erases one project's auth data. Outside /agents/* on purpose:
		// reachable only over the dashboard's service binding. The console owns
		// the fan-out across agents, so this endpoint knows nothing about any
		// agent but its own.
		const erase = url.pathname.match(/^\/internal\/projects\/([^/]+)$/);
		if (erase && request.method === 'DELETE') {
			const projectId = decodeURIComponent(erase[1]);
			if (!projectIdSchema.safeParse(projectId).success) {
				return Response.json({ error: 'invalid project id' }, { status: 400 });
			}
			const agent = await getAgentByName<Env, AuthAgentBase>(this.env.AuthAgent, projectId);
			try {
				await agent.destroy();
			} catch (error) {
				// The agent's deferred abort() can outrace the RPC reply in
				// production after a COMPLETED erase - storage is already gone.
				const message = error instanceof Error ? error.message : String(error);
				if (!/abort\(\) to reset|durable object reset/i.test(message)) throw error;
			}
			return Response.json({ erased: true });
		}

		const response =
			(await routeAgentRequest(request, this.env)) ??
			Response.json({ error: 'not found' }, { status: 404 });

		if (response.status >= 500) {
			// Wrapped: reporting a failure must never turn into a second one
			// that replaces the user's response (mirrors the db agent).
			try {
				const body = await response
					.clone()
					.text()
					.then((value) => value.slice(0, 2048))
					.catch(() => '<unavailable>');

				Sentry.captureMessage(`Auth agent returned HTTP ${response.status}`, {
					level: 'error',
					tags: {
						'http.method': request.method,
						'http.status_code': response.status,
					},
					contexts: {
						response: {
							body,
							contentType: response.headers.get('content-type'),
						},
					},
					extra: {
						pathname: url.pathname,
					},
				});
			} catch {
				// reporting must never replace the response
			}
		}

		return response;
	}
}

export default Sentry.withSentry(sentryOptions, AuthService);
