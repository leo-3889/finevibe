import { instances } from './instance.js';
import { renderBoard, hideBoardView, resetBoardViewIf } from '../board/board-view.js';
import { createTabPaneShell } from '../tab-pane.js';

const pane = createTabPaneShell({
  instances,
  className: 'kanban-pane',
  onShow: (instance) => renderBoard(instance.element),
  onHideAll: hideBoardView,
  // C2R-16: the destroyed pane carried board-view's singleton; drop the
  // reference so its per-tick status/cost patches stop scanning a detached
  // tree. renderBoard() rebuilds on demand for any surviving pane.
  // C3R-04: only when this pane owns the singleton — the shell's destroy()
  // detached `element` with the board inside it, so `contains` still sees
  // the subtree; a background pane's destroy leaves the visible board intact.
  onDestroy: (instance) => resetBoardViewIf(instance.element),
});

export const createKanbanPane = pane.create;
export const attachKanbanToContainer = pane.attach;
export const showKanbanPane = pane.show;
export const hideAllKanbanPanes = pane.hideAll;
export const destroyKanbanPane = pane.destroy;

export { getKanbanInstance } from './instance.js';
