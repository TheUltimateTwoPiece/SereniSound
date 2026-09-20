import "server-only";

/**
 * Caregiver routes are called by the dashboard in the same deployment. Requests
 * without an Origin header (curl, server-to-server) are allowed so the project
 * stays testable from the command line.
 */
export function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}
