export interface TopFilesConfig {
  limit: number;
}

export const DEFAULT_TOP_FILES_CONFIG: TopFilesConfig = {
  limit: 10,
};

export const TOP_FILES_LIMIT_MIN = 1;
export const TOP_FILES_LIMIT_MAX = 50;

export function resolveTopFilesConfig(cfg: Partial<TopFilesConfig> | undefined): TopFilesConfig {
  return {
    limit: typeof cfg?.limit === 'number' ? cfg.limit : DEFAULT_TOP_FILES_CONFIG.limit,
  };
}
