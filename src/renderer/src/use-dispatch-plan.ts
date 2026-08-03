import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentInstanceId,
  DispatchPlan,
  ProjectId,
  WorkbenchPort
} from './workbench/contract'

export function useDispatchPlan({
  planDispatch,
  revision,
  projectId,
  targetIds,
  enabled
}: {
  planDispatch: WorkbenchPort['planDispatch']
  revision: number
  projectId: ProjectId
  targetIds: readonly AgentInstanceId[]
  enabled: boolean
}): {
  plan: DispatchPlan | null
  planning: boolean
  error: string | null
  retry: () => void
} {
  const [receivedPlan, setReceivedPlan] = useState<DispatchPlan | null>(null)
  const [requestPending, setRequestPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryAttempt, setRetryAttempt] = useState(0)
  const generationRef = useRef(0)
  const retry = useCallback(() => setRetryAttempt((attempt) => attempt + 1), [])
  const targetKey = targetIds.join('\u0000')
  const planIsCurrent =
    receivedPlan?.revision === revision &&
    receivedPlan.projectId === projectId &&
    receivedPlan.entries.length === targetIds.length &&
    receivedPlan.entries.every(
      (entry, index) => entry.agentInstanceId === targetIds[index]
    )
  const plan = planIsCurrent ? receivedPlan : null

  useEffect(() => {
    const generation = ++generationRef.current
    if (!enabled || targetIds.length === 0) {
      setReceivedPlan(null)
      setRequestPending(false)
      setError(null)
      return
    }

    const requestedTargetIds = [...targetIds]
    setReceivedPlan(null)
    setRequestPending(true)
    setError(null)
    void planDispatch({
      expectedRevision: revision,
      projectId,
      targets: requestedTargetIds
    }).then(
      (result) => {
        if (generationRef.current !== generation) return
        if (!result.ok) {
          setError(result.message)
          setRequestPending(false)
          return
        }
        const matchesRequest =
          result.plan.revision === revision &&
          result.plan.projectId === projectId &&
          result.plan.entries.length === requestedTargetIds.length &&
          result.plan.entries.every(
            (entry, index) =>
              entry.agentInstanceId === requestedTargetIds[index]
          )
        if (!matchesRequest) {
          setError('调度预览已变化，请重试')
          setRequestPending(false)
          return
        }
        setReceivedPlan(result.plan)
        setRequestPending(false)
      },
      () => {
        if (generationRef.current !== generation) return
        setError('无法计算调度预览，请重试')
        setRequestPending(false)
      }
    )
    return () => {
      if (generationRef.current === generation) generationRef.current += 1
    }
  }, [enabled, planDispatch, projectId, retryAttempt, revision, targetKey])

  return {
    plan,
    planning: enabled && !error && (requestPending || plan === null),
    error,
    retry
  }
}
