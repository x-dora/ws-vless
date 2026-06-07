import { describe, expect, it, vi } from 'vitest';
import { TunnelTrafficReporter } from '../src/handlers/tunnel-traffic';
import { TrafficStatsService } from '../src/services/stats-reporter';
import type { ConnLogFunction } from '../src/types';
import { createSubrequestBudget } from '../src/utils/subrequest-budget';

function createLog(): ConnLogFunction {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

describe('TunnelTrafficReporter', () => {
  it('reports tracked traffic once through waitUntil', async () => {
    const service = new TrafficStatsService({ endpoint: 'https://stats.example.test/report' });
    const report = vi.spyOn(service, 'report').mockResolvedValue(true);
    const executionContext = createExecutionContext();
    const reporter = new TunnelTrafficReporter({
      scope: {
        executionContext,
        budget: createSubrequestBudget(48),
      },
      service,
      log: createLog(),
    });

    const tracker = reporter.start('user-1', 'example.com:443', 'tcp');
    expect(tracker).not.toBeNull();

    reporter.addTraffic(11, 17);
    await reporter.report('closed');
    await reporter.report('closed-again');

    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0][0]).toMatchObject({
      uuid: 'user-1',
      target: 'example.com:443',
      type: 'tcp',
      uplink: 11,
      downlink: 17,
    });
    expect(executionContext.waitUntil).toHaveBeenCalledOnce();
  });

  it('skips reports when no traffic was recorded', async () => {
    const service = new TrafficStatsService({ endpoint: 'https://stats.example.test/report' });
    const report = vi.spyOn(service, 'report').mockResolvedValue(true);
    const executionContext = createExecutionContext();
    const reporter = new TunnelTrafficReporter({
      scope: {
        executionContext,
        budget: createSubrequestBudget(48),
      },
      service,
      log: createLog(),
    });

    reporter.start('user-1', 'example.com:443', 'tcp');
    await reporter.report('empty');

    expect(report).not.toHaveBeenCalled();
    expect(executionContext.waitUntil).not.toHaveBeenCalled();
  });

  it('does not keep a tracker when the stats service is disabled', async () => {
    const service = new TrafficStatsService({ enabled: false });
    const report = vi.spyOn(service, 'report').mockResolvedValue(true);
    const executionContext = createExecutionContext();
    const reporter = new TunnelTrafficReporter({
      scope: {
        executionContext,
        budget: createSubrequestBudget(48),
      },
      service,
      log: createLog(),
    });

    expect(reporter.start('user-1', 'example.com:443', 'tcp')).toBeNull();
    reporter.addTraffic(11, 17);
    await reporter.report('disabled');

    expect(reporter.currentTracker).toBeNull();
    expect(report).not.toHaveBeenCalled();
    expect(executionContext.waitUntil).not.toHaveBeenCalled();
  });

  it('only logs false reports as warnings when the caller opts in', async () => {
    const service = new TrafficStatsService({ endpoint: 'https://stats.example.test/report' });
    vi.spyOn(service, 'report').mockResolvedValue(false);
    const log = createLog();

    const reporter = new TunnelTrafficReporter({
      scope: {
        executionContext: createExecutionContext(),
        budget: createSubrequestBudget(48),
      },
      service,
      log,
    });

    reporter.start('user-1', 'example.com:443', 'tcp');
    reporter.addTraffic(11, 17);
    await reporter.report('closed');

    expect(log.warn).not.toHaveBeenCalled();

    const warningReporter = new TunnelTrafficReporter({
      scope: {
        executionContext: createExecutionContext(),
        budget: createSubrequestBudget(48),
      },
      service,
      log,
      warnOnReportFalse: true,
    });

    warningReporter.start('user-2', 'example.net:443', 'xhttp');
    warningReporter.addTraffic(19, 23);
    await warningReporter.report('closed');

    expect(log.warn).toHaveBeenCalledWith('Stats report returned false (closed)');
  });
});
