import type { AgentProviderId, WorkbenchViewModel } from './contract'

type ProviderViewModel = WorkbenchViewModel['global']['providers'][number]

export type ProviderModelSelection =
  | { ok: true; provider: ProviderViewModel }
  | {
      ok: false
      code:
        | 'provider-missing'
        | 'provider-unavailable'
        | 'model-missing'
        | 'model-unsupported'
      message: string
    }

/**
 * Resolves an Agent creation selection against the provider capability facts
 * exposed by the WorkbenchPort. The renderer and adapter share this rule so a
 * forged command cannot bypass the UI validation.
 */
export function resolveProviderModelSelection(
  providers: WorkbenchViewModel['global']['providers'],
  providerId: AgentProviderId,
  modelId: string
): ProviderModelSelection {
  const provider = providers.find((entry) => entry.providerId === providerId)
  if (!provider) {
    return {
      ok: false,
      code: 'provider-missing',
      message: 'Provider 不存在，请重新选择'
    }
  }
  if (provider.status !== 'ready') {
    return {
      ok: false,
      code: 'provider-unavailable',
      message: 'Provider Doctor 未通过，不能创建实例'
    }
  }
  if (modelId.trim().length === 0) {
    return {
      ok: false,
      code: 'model-missing',
      message: `请选择 ${provider.displayName} 的模型`
    }
  }
  if (!provider.models.some((model) => model.modelId === modelId)) {
    return {
      ok: false,
      code: 'model-unsupported',
      message: `${provider.displayName} 不支持模型 "${modelId}"，请选择兼容模型`
    }
  }
  return { ok: true, provider }
}
