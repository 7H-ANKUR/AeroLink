/**
 * Shared state-color mapping — one visual language across viewport,
 * telemetry and logs (docs/Frontend-Design §32: UI mirrors the backend
 * state machine 1:1).
 */
import type { TrackingStateName } from '@/engine/types';

export const STATE_COLORS: Record<TrackingStateName, string> = {
  SEARCH: 'var(--text-2)',
  CANDIDATE: 'var(--warning)',
  ACQUIRE: 'var(--accent-blue)',
  TRACK: 'var(--success)',
  PREDICT_REACQUIRE: 'var(--prediction)',
};

export const STATE_LABELS: Record<TrackingStateName, string> = {
  SEARCH: 'SEARCH',
  CANDIDATE: 'CANDIDATE',
  ACQUIRE: 'ACQUIRE',
  TRACK: 'TRACK',
  PREDICT_REACQUIRE: 'PREDICT / REACQUIRE',
};

export const STATE_ICONS: Record<TrackingStateName, string> = {
  SEARCH: '◌',
  CANDIDATE: '◔',
  ACQUIRE: '◑',
  TRACK: '●',
  PREDICT_REACQUIRE: '◐',
};
