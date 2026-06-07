import type { RequestScope } from '../app/types';
import type { TrafficStatsService, TrafficTracker, TrafficType } from '../services/stats-reporter';
import type { ConnLogFunction } from '../types';

interface TunnelTrafficReporterOptions {
  scope: RequestScope;
  service: TrafficStatsService;
  log: ConnLogFunction;
  label?: string;
  warnOnReportFalse?: boolean;
}

export class TunnelTrafficReporter {
  private tracker: TrafficTracker | null = null;

  constructor(private readonly options: TunnelTrafficReporterOptions) {}

  get currentTracker(): TrafficTracker | null {
    return this.tracker;
  }

  start(uuid: string | undefined, target: string, type: TrafficType): TrafficTracker | null {
    if (!this.options.service.isEnabled || !uuid) {
      this.tracker = null;
      return null;
    }

    this.tracker = this.options.service.createTracker(uuid, target, type);
    return this.tracker;
  }

  addTraffic(uplink: number, downlink: number): void {
    this.tracker?.addUplink(uplink);
    this.tracker?.addDownlink(downlink);
  }

  report(reason?: string): Promise<void> {
    const tracker = this.tracker;
    if (!tracker) {
      this.logSkipped('no traffic tracker', reason);
      return Promise.resolve();
    }

    const stats = tracker.getStats();
    this.options.log.debug(`Traffic: ↑${stats.uplink} ↓${stats.downlink}${formatReason(reason)}`);

    if (tracker.isReported()) {
      this.logSkipped('already reported', reason);
      return Promise.resolve();
    }

    if (!tracker.hasTraffic()) {
      this.logSkipped('no traffic', reason);
      return Promise.resolve();
    }

    tracker.markReported();
    const reportPromise = this.options.service
      .report(stats, this.options.scope.budget)
      .then((ok) => {
        if (ok) {
          this.options.log.debug(`Stats reported${formatReason(reason)}`);
        } else if (this.options.warnOnReportFalse) {
          this.options.log.warn(`Stats report returned false${formatReason(reason)}`);
        }
      })
      .catch((error) => {
        this.options.log.error(`Stats report error${formatReason(reason)}: ${String(error)}`);
      });

    this.options.scope.executionContext.waitUntil(reportPromise);
    return reportPromise;
  }

  private logSkipped(detail: string, reason?: string): void {
    const label = this.options.label ? `${this.options.label} ` : '';
    this.options.log.debug(`${label}traffic report skipped${formatReason(reason)}: ${detail}`);
  }
}

function formatReason(reason: string | undefined): string {
  return reason ? ` (${reason})` : '';
}
