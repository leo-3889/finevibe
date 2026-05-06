export interface SessionsConfig {
  recentLimit: number;
}

export const DEFAULT_SESSIONS_CONFIG: SessionsConfig = {
  recentLimit: 5,
};

export const SESSIONS_RECENT_LIMIT_MIN = 1;
export const SESSIONS_RECENT_LIMIT_MAX = 50;
