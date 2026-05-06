export interface GithubConfig {
  /** "owner/name" override; if omitted the widget auto-detects from the project's git remote. */
  repo?: string;
  state: 'open' | 'closed' | 'all';
  max: number;
  refreshSeconds: number;
}

export const DEFAULT_GITHUB_CONFIG: GithubConfig = {
  state: 'open',
  max: 10,
  refreshSeconds: 300,
};
