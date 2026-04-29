/**
 * ws-vless Worker 入口
 *
 * 这里只保留 fetch 启动器，真正的应用对象由 App/Router/Gateway 层处理。
 */

import { getWorkerApp } from './app/worker-app';
import type { WorkerEnv } from './types';

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    return await getWorkerApp(env).fetch(request, env, ctx);
  },
};
