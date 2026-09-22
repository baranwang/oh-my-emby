import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from "@/components/ui/breadcrumb"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle
} from "@/components/ui/drawer"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { ScrollArea } from "@/components/ui/scroll-area"
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
import { PasswordForm } from "@/modules/auth/components/password-form"
import { changePassword, logout, sessionQueryOptions } from "@/modules/auth/services/auth-service"
import { m } from "@/paraglide/messages.js"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router"
import {
  ActivityIcon,
  ChevronsUpDownIcon,
  HouseIcon,
  KeyRoundIcon,
  LibraryIcon,
  LogOutIcon,
  ServerIcon,
  UserRoundIcon
} from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"

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
  const password = useMutation({
    mutationFn: (input: Parameters<typeof changePassword>[0]) => changePassword(input, queryClient)
  })
  const [logoutError, setLogoutError] = useState(false)
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
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
        <SidebarHeader>
          <Link className="min-w-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring" to="/">
            <span className="block truncate font-semibold font-heading">{m.app_name()}</span>
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
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<SidebarMenuButton tooltip={session.data?.username ?? m.account_menu()} />}
                >
                  <UserRoundIcon aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate group-data-[collapsible=icon]:hidden">
                    {session.data?.username ?? m.account_menu()}
                  </span>
                  <ChevronsUpDownIcon aria-hidden="true" className="group-data-[collapsible=icon]:hidden" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" className="w-(--anchor-width)">
                  <DropdownMenuItem onClick={() => setPasswordOpen(true)}>
                    <KeyRoundIcon aria-hidden="true" />
                    {m.change_password()}
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={isLoggingOut} onClick={() => void logOut()}>
                    <LogOutIcon aria-hidden="true" />
                    {m.logout()}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
          {logoutError && <p role="alert" className="px-2 text-sm text-destructive">{m.request_failed()}</p>}
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
        </header>
        <main id="main-content" className="flex-1 p-6 md:p-8">
          {children}
        </main>
      </SidebarInset>
      <Drawer open={passwordOpen} onOpenChange={setPasswordOpen} swipeDirection="right">
        <DrawerContent className="data-[swipe-axis=x]:sm:[--drawer-content-width:28rem]">
          <DrawerHeader>
            <DrawerTitle>{m.password_change_title()}</DrawerTitle>
            <DrawerDescription>{m.password_change_description()}</DrawerDescription>
          </DrawerHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-4">
              <PasswordForm
                onChangePassword={(input) => password.mutateAsync(input)}
                onChanged={async () => {
                  setPasswordOpen(false)
                  await router.invalidate()
                  await navigate({ to: "/login" })
                }}
              />
            </div>
          </ScrollArea>
        </DrawerContent>
      </Drawer>
    </SidebarProvider>
  )
}
