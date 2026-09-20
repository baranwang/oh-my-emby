import { useEffect, useState, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router"
import {
  ActivityIcon,
  HouseIcon,
  LibraryIcon,
  LogOutIcon,
  ServerIcon
} from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger
} from "@/components/ui/sidebar"
import { logout, sessionQueryOptions } from "@/modules/auth/services/auth-service"
import { m } from "@/paraglide/messages.js"
import { getLocale, setLocale } from "@/paraglide/runtime.js"

type AppShellProps = { readonly children: ReactNode }

export const sectionFromPathname = (pathname: string) => pathname
  .replace(/^\/dashboard\/?/, "")
  .replace(/^\//, "")
  .split("/")[0] ?? ""

export const AppShell = ({ children }: AppShellProps) => {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const navigate = useNavigate()
  const router = useRouter()
  const queryClient = useQueryClient()
  const session = useQuery(sessionQueryOptions)
  const { theme, setTheme } = useTheme()
  const [logoutError, setLogoutError] = useState(false)
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const section = sectionFromPathname(pathname)
  const navigation = [
    { slug: "", label: m.overview(), icon: HouseIcon },
    { slug: "servers", label: m.servers(), icon: ServerIcon },
    { slug: "libraries", label: m.libraries(), icon: LibraryIcon },
    { slug: "system", label: m.system(), icon: ActivityIcon }
  ]
  const pageTitle = navigation.find((item) => item.slug === section)?.label ?? m.page_not_found_title()

  useEffect(() => {
    if (session.data?.authenticated === false) void router.invalidate()
  }, [router, session.data?.authenticated])

  const logOut = async () => {
    setLogoutError(false)
    setIsLoggingOut(true)
    try {
      await logout(queryClient)
      await router.invalidate()
      await navigate({ to: "/login" })
    } catch {
      setLogoutError(true)
    } finally {
      setIsLoggingOut(false)
    }
  }

  return (
    <SidebarProvider labels={{
      toggle: m.navigation_toggle(),
      title: m.navigation_title(),
      description: m.navigation_description(),
      close: m.navigation_close()
    }}>
      <Sidebar collapsible="icon">
        <SidebarHeader className="border-b border-sidebar-border p-3">
          <Link className="min-w-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring" to="/">
            <span className="block truncate text-sm font-semibold">{m.app_name()}</span>
            <span className="block truncate text-xs text-sidebar-foreground/70 group-data-[collapsible=icon]:hidden">
              {m.app_description()}
            </span>
          </Link>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu aria-label={m.navigation_label()}>
                {navigation.map(({ slug, label, icon: Icon }) => (
                  <SidebarMenuItem key={slug || "overview"}>
                    <SidebarMenuButton
                      isActive={section === slug}
                      tooltip={label}
                      render={slug
                        ? <Link to="/$" params={{ _splat: slug }} />
                        : <Link to="/" />}
                    >
                      <Icon aria-hidden="true" />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="border-t border-sidebar-border">
          <Button
            variant="ghost"
            className="w-full justify-start group-data-[collapsible=icon]:px-2"
            disabled={isLoggingOut}
            onClick={() => void logOut()}
          >
            <LogOutIcon aria-hidden="true" />
            <span className="group-data-[collapsible=icon]:hidden">{m.logout()}</span>
          </Button>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="flex min-h-14 flex-wrap items-center gap-3 border-b px-4 py-2 md:px-6">
          <SidebarTrigger />
          <Breadcrumb aria-label={m.breadcrumb_label()} className="min-w-0 flex-1">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink render={<Link to="/" />}>{m.app_name()}</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{pageTitle}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <label className="sr-only" htmlFor="dashboard-language">{m.language_label()}</label>
          <select
            id="dashboard-language"
            className="h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={getLocale()}
            onChange={(event) => {
              const locale = event.currentTarget.value
              if (locale === "en" || locale === "zh-CN") {
                document.documentElement.lang = locale
                setLocale(locale)
              }
            }}
          >
            <option value="en">{m.language_english()}</option>
            <option value="zh-CN">{m.language_chinese()}</option>
          </select>
          <label className="sr-only" htmlFor="dashboard-theme">{m.theme_label()}</label>
          <select
            id="dashboard-theme"
            className="h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={theme}
            onChange={(event) => {
              const value = event.currentTarget.value
              if (value === "system" || value === "light" || value === "dark") setTheme(value)
            }}
          >
            <option value="system">{m.theme_system()}</option>
            <option value="light">{m.theme_light()}</option>
            <option value="dark">{m.theme_dark()}</option>
          </select>
          {logoutError && <p role="alert" className="basis-full text-sm text-destructive">{m.request_failed()}</p>}
        </header>
        <main id="main-content" className="flex-1 p-6 md:p-8">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
