// frontend/src/hooks/useSwipeGesture.ts
import { useRef, useState, useCallback } from 'react'
import { SWIPE_THRESHOLD } from '../lib/swipe'

export interface GestureState {
  dx: number
  dy: number
  dragging: boolean
}

const IDLE: GestureState = { dx: 0, dy: 0, dragging: false }

interface UseSwipeGestureResult {
  state: GestureState
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  onPointerCancel: () => void
  reset: () => void
}

/**
 * Tracks pointer drag gestures and triple-tap on a single card element.
 *
 * - Drag past SWIPE_THRESHOLD → calls onCommit(dx, dy) with raw deltas
 * - Drag below threshold → snaps back to IDLE
 * - 3 taps within 500ms → calls onTripleTap()
 */
export function useSwipeGesture(
  onCommit: (dx: number, dy: number) => void,
  onTripleTap: () => void,
): UseSwipeGestureResult {
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const tapCountRef = useRef(0)
  const tapTimerRef = useRef<ReturnType<typeof setTimeout>>()
  // Use refs for callbacks to avoid stale closures in pointer handlers
  const onCommitRef = useRef(onCommit)
  const onTripleTapRef = useRef(onTripleTap)
  onCommitRef.current = onCommit
  onTripleTapRef.current = onTripleTap

  const [state, setState] = useState<GestureState>(IDLE)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Capture so we keep receiving events even if pointer leaves element
    e.currentTarget.setPointerCapture(e.pointerId)
    startRef.current = { x: e.clientX, y: e.clientY }
    setState(s => ({ ...s, dx: 0, dy: 0, dragging: true }))
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!startRef.current) return
    const dx = e.clientX - startRef.current.x
    const dy = e.clientY - startRef.current.y
    setState(s => ({ ...s, dx, dy }))
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!startRef.current) return
    const dx = e.clientX - startRef.current.x
    const dy = e.clientY - startRef.current.y
    startRef.current = null

    if (Math.hypot(dx, dy) < 8) {
      // Treat as tap
      clearTimeout(tapTimerRef.current)
      tapCountRef.current += 1
      tapTimerRef.current = setTimeout(() => { tapCountRef.current = 0 }, 500)
      if (tapCountRef.current >= 3) {
        tapCountRef.current = 0
        onTripleTapRef.current()
      }
      setState(IDLE)
      return
    }

    if (Math.hypot(dx, dy) >= SWIPE_THRESHOLD) {
      setState({ dx, dy, dragging: false })
      onCommitRef.current(dx, dy)
    } else {
      // Below threshold — spring back
      setState(IDLE)
    }
  }, [])

  const reset = useCallback(() => {
    setState(IDLE)
    startRef.current = null
  }, [])

  const onPointerCancel = useCallback(() => {
    reset()
  }, [reset])

  return { state, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, reset }
}
