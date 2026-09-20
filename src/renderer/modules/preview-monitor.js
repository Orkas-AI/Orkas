// The main renderer owns telemetry identity and broadcast subscriptions.
// Forward only this window's existing action/result events to that owner.
window.Monitor = Object.fromEntries(['click', 'event', 'error'].map(method => [method, (action, data) => {
  window.orkas.invoke('previewWindows.report', { kind: 'telemetry', method, action, data: data || {} }).catch(() => {});
}]));
