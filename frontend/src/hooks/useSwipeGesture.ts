// frontend/src/hooks/useSwipeGesture.ts
import { useRef, useState, useCallback } from 'react'
import { detectDirection, SWIPE_THRESHOLD, type SwipeDirection } from '../lib/swipe'

export interface GestureState {
  dx: number
  dy: number
  dragging: boolean
  lockedDirection: SwipeDirection | null
}

const IDLE: GestureState = { dx: 0, dy: 0, dragging: false, lockedDirection: null }

interface UseSwipeGestureResult {
  state: GestureState
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  reset: () => void
}

/**
 * Tracks pointer drag gestures and triple-tap on a single card element.
 *
 * - Drag past SWIPE_THRESHOLD → calls onDirectionCommit(dir) and locks state
 * - Drag below threshold → snaps back to IDLE
 * - 3 taps within 500ms → calls onTripleTap()
 */
export function useSwipeGesture(
  onDirectionCommit: (dir: SwipeDirection) => void,
  onTripleTap: () => void,
): UseSwipeGestureResult {
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const tapCountRef = useRef(0)
  const tapTimerRef = useRef<ReturnType<typeof setTimeout>>()
  // Use refs for callbacks to avoid stale closures in pointer handlers
  const onCommitRef = useRef(onDirectionCommit)
  const onTripleTapRef = useRef(onTripleTap)
  onCommitRef.current = onDirectionCommit
  onTripleTapRef.current = onTripleTap

  const [state, setState] = useState<GestureState>(IDLE)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Capture so we keep receiving events even if pointer leaves element
    e.currentTarget.setPointerCapture(e.pointerId)
    startRef.current = { x: e.clientX, y: e.clientY }
    setState(s => ({ ...s, dx: 0, dy: 0, dragging: true, lockedDirection: null }))
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

    const dir = detectDirection(dx, dy, SWIPE_THRESHOLD)
    if (dir) {
      setState({ dx, dy, dragging: false, lockedDirection: dir })
      onCommitRef.current(dir)
    } else {
      // Below threshold — spring back
      setState(IDLE)
    }
  }, [])

  const reset = useCallback(() => {
    setState(IDLE)
    startRef.current = null
  }, [])

  return { state, onPointerDown, onPointerMove, onPointerUp, reset }
}
