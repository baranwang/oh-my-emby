import { Context, Effect } from "effect"

export interface ApplicationServices {
  readonly handleDashboard: (request: Request) => Effect.Effect<Response>
  readonly handleEmby: (request: Request) => Effect.Effect<Response>
  readonly handleDashboardAsset: (request: Request) => Effect.Effect<Response>
}

export const ApplicationServices = Context.Service<ApplicationServices>(
  "oh-my-emby/ApplicationServices"
)

const jsonNotFound = () => Response.json({
  error: { code: "NotFound", message: "Resource not found" }
}, { status: 404 })

const safePath = (pathname: string): string | null => {
  try {
    const decoded = decodeURIComponent(pathname)
    if (
      decoded.includes("%") ||
      decoded.includes("\\") ||
      decoded.includes("\0") ||
      decoded.split("/").some((part) => part === "..")
    ) {
      return null
    }
    return decoded
  } catch {
    return null
  }
}

export const isDashboardNavigationRequest = (request: Request): boolean => {
  if (request.method !== "GET" && request.method !== "HEAD") return false
  if (!request.headers.get("accept")?.toLowerCase().includes("text/html")) return false
  const pathname = safePath(new URL(request.url).pathname)
  if (pathname === null || (pathname !== "/dashboard" && !pathname.startsWith("/dashboard/"))) return false
  const leaf = pathname.slice(pathname.lastIndexOf("/") + 1)
  return !leaf.includes(".")
}

const isEmbyPath = (pathname: string): boolean => pathname === "/emby" || pathname.startsWith("/emby/") || [
  "/System/",
  "/Users/",
  "/Items",
  "/Videos/",
  "/Sessions/"
].some((prefix) => pathname.startsWith(prefix))

export const routeApplication = (
  request: Request
): Effect.Effect<Response, never, ApplicationServices> => Effect.gen(function*() {
  const services = yield* ApplicationServices
  const pathname = new URL(request.url).pathname

  if (pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) {
    return Response.json({ status: "ok" })
  }
  if (pathname === "/api/dashboard" || pathname.startsWith("/api/dashboard/")) {
    return yield* services.handleDashboard(request)
  }
  if (isEmbyPath(pathname)) return yield* services.handleEmby(request)
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) {
    return yield* services.handleDashboardAsset(request)
  }
  return jsonNotFound()
})
