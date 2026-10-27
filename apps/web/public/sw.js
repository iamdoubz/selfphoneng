// SPDX-License-Identifier: AGPL-3.0-or-later
// The softphone's incoming call notification (05 §5). Only a service worker's notifications can
// carry buttons. The softphone tab asks for one here; Answer/Decline go back to that tab only.
/* global self */
self.addEventListener('message', (e) => {
  const call = e.data?.notifyCall;
  if (!call) return;
  e.waitUntil(
    self.registration.showNotification('Incoming call', {
      body: call.body,
      tag: call.id,
      requireInteraction: true,
      actions: [
        { action: 'answer', title: 'Answer' },
        { action: 'decline', title: 'Decline' },
      ],
      data: { id: call.id, tab: e.source.id },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { id, tab } = e.notification.data;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (all) => {
      const client = all.find((c) => c.id === tab);
      if (!client) return;
      if (e.action) client.postMessage({ softphone: e.action, id });
      // Declining needs nothing from the tab; otherwise bring it back.
      if (e.action !== 'decline') await client.focus();
    }),
  );
});
