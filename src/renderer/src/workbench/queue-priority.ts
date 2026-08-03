import type { QueueItemViewModel } from './contract'

export type QueuePriority = QueueItemViewModel['priority']
export type QueuePriorityOperation = 'raise-priority' | 'lower-priority'

export const QUEUE_PRIORITY_ORDER = [
  'low',
  'normal',
  'high'
] as const satisfies readonly QueuePriority[]

/**
 * Move exactly one level in the queue priority order.
 *
 * `undefined` marks a boundary operation, so callers can disable it in the
 * renderer or reject a forged command without creating a meaningless
 * revision in the port.
 */
export function stepQueuePriority(
  priority: QueuePriority,
  operation: QueuePriorityOperation
): QueuePriority | undefined {
  const index = QUEUE_PRIORITY_ORDER.indexOf(priority)
  if (index < 0) return undefined
  const nextIndex = index + (operation === 'raise-priority' ? 1 : -1)
  return QUEUE_PRIORITY_ORDER[nextIndex]
}
