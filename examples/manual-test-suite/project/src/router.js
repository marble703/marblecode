export function registerRoute(router, path, handler) {
  const exists = router.routes.some((route) => route.path === path);
  if (exists) {
    throw new Error(`duplicate route registration: ${path}`);
  }

  router.routes.push({ path, handler });
}

export function createRouter() {
  return { routes: [] };
}
