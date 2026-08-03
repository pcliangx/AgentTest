import { describe, expectTypeOf, it } from 'vitest'
import type {
  ActivityEntry,
  QueueItemId,
  ResourceBindingId,
  ResourceBindingViewModel
} from './contract'

describe('WorkbenchPort contract — branded IDs', () => {
  it('keeps Resource Binding identity opaque and non-interchangeable', () => {
    expectTypeOf<
      ResourceBindingViewModel['bindingId']
    >().toEqualTypeOf<ResourceBindingId>()
  })

  it('requires stable queue identity and reason on cancellation activity', () => {
    type QueueCancellation = Extract<
      ActivityEntry,
      { kind: 'queue-cancelled' }
    >

    expectTypeOf<QueueCancellation['queueItemId']>().toEqualTypeOf<QueueItemId>()
    expectTypeOf<QueueCancellation['reason']>().toEqualTypeOf<'user-cancelled'>()
  })
})
