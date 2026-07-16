export type ClientChannel = 'open';

/** The public build always identifies itself as the open channel. */
export function resolveClientChannel(): ClientChannel {
  return 'open';
}

export function currentClientChannel(): ClientChannel {
  return 'open';
}
