import type { BrowserTabInstance, FlowPickerMetadata } from './types.js';

export function showFlowPicker(instance: BrowserTabInstance, metadata: FlowPickerMetadata, x: number, y: number): void {
  const webviewRect = (instance.webview as unknown as HTMLElement).getBoundingClientRect();
  const paneRect = instance.element.getBoundingClientRect();
  let left = webviewRect.left - paneRect.left + x;
  let top = webviewRect.top - paneRect.top + y;

  instance.flowPickerPending = metadata;
  instance.flowPickerMenu.style.left = `${left}px`;
  instance.flowPickerMenu.style.top = `${top}px`;
  instance.flowPickerOverlay.style.display = 'block';

  // Clamp after display so we can read actual rendered dimensions
  const menuRect = instance.flowPickerMenu.getBoundingClientRect();
  const paneWidth = paneRect.width;
  const paneHeight = paneRect.height;
  if (left + menuRect.width > paneWidth) left = paneWidth - menuRect.width - 8;
  if (top + menuRect.height > paneHeight) top = paneHeight - menuRect.height - 8;
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  instance.flowPickerMenu.style.left = `${left}px`;
  instance.flowPickerMenu.style.top = `${top}px`;
}

export function dismissFlowPicker(instance: BrowserTabInstance): void {
  instance.flowPickerOverlay.style.display = 'none';
  instance.flowPickerPending = null;
}
