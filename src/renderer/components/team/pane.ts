import { instances } from './instance.js';
import { renderTeam, hideTeamView } from './team-view.js';
import { createTabPaneShell } from '../tab-pane.js';

const pane = createTabPaneShell({
  instances,
  className: 'team-pane',
  onShow: (instance) => renderTeam(instance.element),
  onHideAll: hideTeamView,
});

export const createTeamPane = pane.create;
export const attachTeamToContainer = pane.attach;
export const showTeamPane = pane.show;
export const hideAllTeamPanes = pane.hideAll;
export const destroyTeamPane = pane.destroy;

export { getTeamInstance } from './instance.js';
