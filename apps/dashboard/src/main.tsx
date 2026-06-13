import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { FlowsPage } from "./pages/flows.tsx";
import { RunDetailPage } from "./pages/run-detail.tsx";
import { RunsPage } from "./pages/runs.tsx";
import { TriggersPage } from "./pages/triggers.tsx";
import "./styles.css";

function Layout() {
  const links = [
    { to: "/", label: "Runs" },
    { to: "/flows", label: "Flows" },
    { to: "/triggers", label: "Triggers" },
  ] as const;
  return (
    <div className="mx-auto max-w-6xl p-6">
      <nav className="mb-6 flex items-center gap-6 border-b border-zinc-800 pb-3">
        <span className="font-bold">⛓ flow</span>
        {links.map(({ to, label }) => (
          <Link
            key={to}
            to={to}
            className="text-sm text-zinc-400 hover:text-white [&.active]:text-white [&.active]:font-semibold"
          >
            {label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}

const rootRoute = createRootRoute({ component: Layout });
const runsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: RunsPage });
const runDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  component: function RunDetail() {
    const { runId } = runDetailRoute.useParams();
    return <RunDetailPage runId={runId} />;
  },
});
const flowsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/flows", component: FlowsPage });
const triggersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/triggers", component: TriggersPage });

const router = createRouter({
  routeTree: rootRoute.addChildren([runsRoute, runDetailRoute, flowsRoute, triggersRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 1000 } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
