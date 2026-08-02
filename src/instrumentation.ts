/**
 * Server-side error reporting.
 *
 * Next invokes onRequestError for every uncaught server-side error —
 * page renders, Server Actions, and route handlers alike — with the
 * route context attached. Each report is relayed to the 508.world
 * router Worker, which owns the email pipeline, and lands as a
 * detailed message at the errors mailbox. The user-facing behaviour
 * (error boundary, digest reference) is unchanged; this only adds the
 * operator's copy of what went wrong.
 *
 * Deliberately fail-silent end to end: an unreachable reporting
 * endpoint must never make an outage worse, and a missing NOTIFY_URL /
 * NOTIFY_SECRET simply means the channel isn't configured yet. The
 * Worker throttles repeats, so an error loop becomes one email per
 * few minutes, not one per request.
 */
export async function onRequestError(
  error: unknown,
  request: Readonly<{ path: string; method: string; headers: NodeJS.Dict<string | string[]> }>,
  context: Readonly<{ routerKind: string; routePath: string; routeType: string }>
): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;

  const url = process.env.NOTIFY_URL;
  const secret = process.env.NOTIFY_SECRET;
  if (!url || !secret) return;

  const err = error instanceof Error ? error : new Error(String(error));
  const host = request.headers["x-forwarded-host"] ?? request.headers["host"];

  try {
    await fetch(`${url}/api/notify/error`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        source: "felix-app",
        message: err.message,
        stack: err.stack,
        digest: (err as { digest?: string }).digest,
        path: request.path,
        method: request.method,
        host: Array.isArray(host) ? host[0] : host,
        route: `${context.routeType} ${context.routePath}`,
      }),
    });
  } catch {
    // The report is best-effort; the error itself is already logged by
    // the runtime and visible in Workers Logs.
  }
}
