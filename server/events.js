// In-process event bus: 'status' (after a committed transition), 'xp' (outbox rows written), 'issue' (created/changed),
// 'scenarios' (scan finished).
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(50);
export const emit = (name, payload) => {
  try { bus.emit(name, payload); } catch (error) { console.error(`[events] ${name} listener failed:`, error?.message ?? error); }
};
