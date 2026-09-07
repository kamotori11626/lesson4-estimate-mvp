import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function runAsUser(user, callback) {
  return storage.run({ user }, callback);
}

export function currentUser() {
  return storage.getStore()?.user || null;
}

export function auditIdentity() {
  const user = currentUser();
  if (!user) return { execution_user_id: 'system', identity_mode: 'system' };
  return { execution_user_id: user.username, display_name: user.displayName, identity_mode: 'authenticated_session' };
}
