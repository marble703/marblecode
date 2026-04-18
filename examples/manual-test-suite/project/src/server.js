import { createRouter } from './router.js';
import { registerAppRoutes } from './register-routes.js';

export function buildServer() {
  const router = createRouter();
  registerAppRoutes(router);
  return router;
}
