export const createLogoutAssignmentRecoveryService = (deps = {}) => {
  const {
    assignQueuedWhatsappConversations,
    log = () => {},
    nowMs = () => Date.now(),
    readStore,
    requeueWhatsappAssignmentsForLogout,
  } = deps;

  if (
    typeof assignQueuedWhatsappConversations !== 'function' ||
    typeof readStore !== 'function' ||
    typeof requeueWhatsappAssignmentsForLogout !== 'function'
  ) {
    throw new Error('Logout assignment recovery dependencies are incomplete.');
  }

  const pendingUserIds = new Set();
  let recoveryQueue = Promise.resolve();

  const scheduleLogoutAssignmentRecovery = (user = {}, reason = 'logout') => {
    const safeUserId = String(user?.id || '').trim();
    if (!safeUserId || pendingUserIds.has(safeUserId)) {
      return false;
    }

    pendingUserIds.add(safeUserId);

    const runRecovery = async () => {
      const startedAt = nowMs();
      try {
        const storeSnapshot = await readStore();
        const currentUser = (Array.isArray(storeSnapshot.users) ? storeSnapshot.users : []).find(
          (item) => String(item?.id || '').trim() === safeUserId,
        ) || user;
        const requeuedConversationIds = await requeueWhatsappAssignmentsForLogout(storeSnapshot, currentUser);
        let reassignedConversations = [];

        if (requeuedConversationIds.length > 0) {
          const refreshedStore = await readStore();
          reassignedConversations = await assignQueuedWhatsappConversations(refreshedStore);
        }

        log(
          `Redistribuicao de logout concluida (${reason}): requeued=${requeuedConversationIds.length} reassigned=${reassignedConversations.length} em ${nowMs() - startedAt}ms.`,
        );
      } catch (error) {
        log(`Falha na redistribuicao de logout (${reason}): ${error?.message || error}`);
      } finally {
        pendingUserIds.delete(safeUserId);
      }
    };

    recoveryQueue = recoveryQueue
      .catch(() => {})
      .then(() => new Promise((resolve) => setImmediate(resolve)))
      .then(runRecovery);

    recoveryQueue.catch(() => {});
    return true;
  };

  return {
    scheduleLogoutAssignmentRecovery,
  };
};
