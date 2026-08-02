import { describe, expectTypeOf, it } from 'vitest'
import type { ResourceBindingId, ResourceBindingViewModel } from './contract'

describe('WorkbenchPort contract — branded IDs', () => {
  it('keeps Resource Binding identity opaque and non-interchangeable', () => {
    expectTypeOf<
      ResourceBindingViewModel['bindingId']
    >().toEqualTypeOf<ResourceBindingId>()
  })
})
