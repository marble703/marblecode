import { registerRoute } from './router.js';

export function registerAppRoutes(router) {
  registerRoute(router, '/health', () => 'ok');
  registerRoute(router, '/users', () => 'users');
}
