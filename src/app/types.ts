import type { SubrequestBudget } from '../utils/subrequest-budget';

export interface RequestScope {
  executionContext: ExecutionContext;
  budget: SubrequestBudget;
}
