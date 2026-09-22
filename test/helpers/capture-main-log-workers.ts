import { expect, vi } from 'vitest';

/** Track the real workers after resetModules so workspace teardown cannot race
 * queued log writes. Wait for delivery before termination to retain evidence. */
export async function captureMainLogWorkers(): Promise<() => Promise<void>> {
  type DeliveryModule = typeof import('../../src/main/util/log-delivery');
  const deliveries: ReturnType<DeliveryModule['createLogDelivery']>[] = [];
  // A persistent module mock, rather than a spy on one module instance, also
  // captures workers created after a case calls resetModules() again.
  vi.doMock('../../src/main/util/log-delivery', async importOriginal => {
    const module = await importOriginal<DeliveryModule>();
    return {
      ...module,
      createLogDelivery: (...args: Parameters<DeliveryModule['createLogDelivery']>) => {
        const delivery = module.createLogDelivery(...args);
        deliveries.push(delivery);
        return delivery;
      },
    };
  });
  return async () => {
    try {
      for (const delivery of deliveries) {
        await vi.waitFor(() => expect(delivery.stats().pending).toBe(0));
        expect(delivery.stats()).toMatchObject({ dropped: 0, failed: false });
      }
    } finally {
      await Promise.all(deliveries.map(delivery => delivery.close()));
      vi.doUnmock('../../src/main/util/log-delivery');
    }
  };
}
