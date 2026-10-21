// Shared context-menu infrastructure. There is a single open context menu
// app-wide — the tab bar's tab/branch/"More" menus and the sidebar's project
// menu all live here; this module owns that state and the dismiss/position
// helpers, so `hideTabContextMenu` is the one "close any open menu" entry
// point and no two menus can coexist.

let activeContextMenu: HTMLElement | null = null;

export function getActiveContextMenu(): HTMLElement | null {
  return activeContextMenu;
}

export function setActiveContextMenu(el: HTMLElement | null): void {
  activeContextMenu = el;
}

export function hideTabContextMenu(): void {
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
}

// Clamp a menu so it stays within the viewport.
export function positionMenu(menu: HTMLElement): void {
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;
}
