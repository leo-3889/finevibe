import type { OverviewWidgetType } from '../../../../shared/types.js';
import type { WidgetFactory } from './widget-host.js';
import { createReadinessWidget } from './readiness-widget.js';
import { createProviderToolsWidget } from './provider-tools-widget.js';
import { createGithubPRsWidget, createGithubIssuesWidget } from './github-widgets.js';
import { createTeamWidget } from './team-widget.js';
import { createKanbanWidget } from './kanban-widget.js';

export interface WidgetMeta {
  type: OverviewWidgetType;
  displayName: string;
  description: string;
  defaultSize: { w: number; h: number };
  defaultConfig: Record<string, unknown>;
  factory: WidgetFactory;
  /** When true the picker allows multiple instances on one Overview. */
  allowMultiple: boolean;
  /** When true, this widget exposes a settings dialog (gear button visible). */
  hasSettings: boolean;
}

const REGISTRY: Record<OverviewWidgetType, WidgetMeta> = {
  'readiness': {
    type: 'readiness',
    displayName: 'AI Readiness',
    description: 'Project readiness score, quick wins, and category breakdown.',
    defaultSize: { w: 8, h: 8 },
    defaultConfig: {},
    factory: createReadinessWidget,
    allowMultiple: false,
    hasSettings: false,
  },
  'provider-tools': {
    type: 'provider-tools',
    displayName: 'Provider Tools',
    description: 'MCP servers, agents, skills, and slash commands for each installed CLI.',
    defaultSize: { w: 4, h: 8 },
    defaultConfig: {},
    factory: createProviderToolsWidget,
    allowMultiple: false,
    hasSettings: false,
  },
  'github-prs': {
    type: 'github-prs',
    displayName: 'Recent PRs',
    description: 'Latest pull requests for a GitHub repo with read/unread badges. Uses the local gh CLI.',
    defaultSize: { w: 6, h: 6 },
    defaultConfig: { state: 'open', max: 10, refreshSeconds: 300 },
    factory: createGithubPRsWidget,
    allowMultiple: true,
    hasSettings: true,
  },
  'github-issues': {
    type: 'github-issues',
    displayName: 'Recent Issues',
    description: 'Latest issues for a GitHub repo with read/unread badges. Uses the local gh CLI.',
    defaultSize: { w: 6, h: 6 },
    defaultConfig: { state: 'open', max: 10, refreshSeconds: 300 },
    factory: createGithubIssuesWidget,
    allowMultiple: true,
    hasSettings: true,
  },
  'team': {
    type: 'team',
    displayName: 'Team',
    description: 'Your team of AI personas. Chat, edit, or manage their sessions.',
    defaultSize: { w: 6, h: 8 },
    defaultConfig: {},
    factory: createTeamWidget,
    allowMultiple: false,
    hasSettings: false,
  },
  'kanban': {
    type: 'kanban',
    displayName: 'Kanban',
    description: 'Project board tasks grouped by column. Click to edit, run, or resume.',
    defaultSize: { w: 6, h: 8 },
    defaultConfig: {},
    factory: createKanbanWidget,
    allowMultiple: false,
    hasSettings: false,
  },
};

export function getWidgetMeta(type: OverviewWidgetType): WidgetMeta | undefined {
  return REGISTRY[type];
}

export function listWidgetTypes(): WidgetMeta[] {
  return Object.values(REGISTRY);
}
