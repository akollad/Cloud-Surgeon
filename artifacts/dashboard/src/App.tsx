import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { Shell } from '@/components/layout/Shell';
import { LoginGate } from '@/components/LoginGate';

import JudgeGuide from '@/pages/guide';
import LiveDiagnostic from '@/pages/live';
import DecisionTrace from '@/pages/decision';
import Incidents from '@/pages/incidents';
import IncidentTimeline from '@/pages/timeline';
import StrategyMemory from '@/pages/memory';
import Calibration from '@/pages/calibration';
import Impact from '@/pages/impact';
import Logs from '@/pages/logs';

const queryClient = new QueryClient();

function Router() {
  return (
    <Shell>
      <Switch>
        <Route path="/" component={JudgeGuide} />
        <Route path="/live" component={LiveDiagnostic} />
        <Route path="/decision" component={DecisionTrace} />
        <Route path="/incidents" component={Incidents} />
        <Route path="/incidents/:incidentId" component={IncidentTimeline} />
        <Route path="/memory" component={StrategyMemory} />
        <Route path="/calibration" component={Calibration} />
        <Route path="/impact" component={Impact} />
        <Route path="/logs" component={Logs} />
        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <LoginGate>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <Router />
          </WouterRouter>
        </LoginGate>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
