import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/hooks/useAuth";
import { OrganizationProvider } from "@/hooks/useOrganization";
import { lazyWithReload } from "@/lib/lazyWithReload";

const Index = lazyWithReload(() => import("./pages/Index.tsx"));
const Auth = lazyWithReload(() => import("./pages/Auth.tsx"));
const ResetPassword = lazyWithReload(() => import("./pages/ResetPassword.tsx"));
const TeamManagement = lazyWithReload(() => import("./pages/TeamManagement.tsx"));
const NotFound = lazyWithReload(() => import("./pages/NotFound.tsx"));

const PageFallback = () => (
  <div className="flex min-h-dvh items-center justify-center bg-background text-sm font-medium text-muted-foreground" role="status" aria-live="polite">
    Carregando plataforma...
  </div>
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Avoid auto-refetching when the user returns to the tab — keeps the
      // screen stable instead of reloading content on focus.
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <OrganizationProvider>
            <Suspense fallback={<PageFallback />}>
              <Routes>
                <Route path="/auth" element={<Auth />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route path="/team" element={<TeamManagement />} />
                <Route path="/" element={<Index />} />
                <Route path="/obras/:routeProjectId/:routeView" element={<Index />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </OrganizationProvider>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
