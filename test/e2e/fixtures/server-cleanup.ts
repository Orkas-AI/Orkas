import type { Server } from 'node:http';
import type { Socket } from 'node:net';

/** Register before listen so teardown owns even incomplete HTTP and upgraded connections. */
export function ownFixtureServer(server: Server): (timeoutMs?: number) => Promise<void> {
  const sockets = new Set<Socket>();
  let closing = false;
  let completion: Promise<void> | undefined;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (closing) socket.destroy();
  });
  return (timeoutMs = 5_000) => {
    if (completion) return completion;
    closing = true;
    completion = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Stub server cleanup exceeded deadline')), timeoutMs);
      // Stop accepting first. closeAllConnections alone excludes upgraded sockets.
      server.close(error => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
      for (const socket of sockets) socket.destroy();
    });
    return completion;
  };
}
