export interface SelectorOption {
  type: 'qa' | 'attr' | 'id' | 'css';
  label: string;
  value: string;
}

export type ActiveSelector = SelectorOption;

export interface ElementInfo {
  tagName: string;
  id: string;
  classes: string[];
  textContent: string;
  selectors: SelectorOption[];
  activeSelector: ActiveSelector;
  pageUrl: string;
}

export interface FlowStep {
  type: 'click' | 'navigate' | 'expect';
  tagName?: string;
  textContent?: string;
  selectors?: SelectorOption[];
  activeSelector?: SelectorOption;
  pageUrl?: string;
  url?: string;
}

export interface FlowPickerMetadata {
  tagName: string;
  textContent: string;
  selectors: SelectorOption[];
  pageUrl: string;
}

export type FlowPickerAction = 'click' | 'record' | 'click-and-record';

export interface ViewportPreset {
  label: string;
  width: number | null;
  height: number | null;
}

export const VIEWPORT_PRESETS: ViewportPreset[] = [
  { label: 'Responsive', width: null, height: null },
  { label: 'iPhone SE',  width: 375,  height: 667  },
  { label: 'iPhone 14',  width: 393,  height: 852  },
  { label: 'Pixel 7',    width: 412,  height: 915  },
  { label: 'iPad Air',   width: 820,  height: 1180 },
  { label: 'iPad Pro',   width: 1024, height: 1366 },
];

export interface WebviewElement extends HTMLElement {
  src: string;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  send(channel: string, ...args: unknown[]): void;
}

export interface BrowserTabInstance {
  element: HTMLDivElement;
  webview: WebviewElement;
  viewportContainer: HTMLDivElement;
  newTabPage: HTMLDivElement;
  urlInput: HTMLInputElement;
  inspectBtn: HTMLButtonElement;
  viewportBtn: HTMLButtonElement;
  viewportDropdown: HTMLDivElement;
  inspectPanel: HTMLDivElement;
  instructionInput: HTMLInputElement;
  elementInfoEl: HTMLDivElement;
  inspectMode: boolean;
  selectedElement: ElementInfo | null;
  currentViewport: ViewportPreset;
  viewportOutsideClickHandler: (e: MouseEvent) => void;
  recordBtn: HTMLButtonElement;
  flowPanel: HTMLDivElement;
  flowPanelLabel: HTMLSpanElement;
  flowStepsList: HTMLDivElement;
  flowInputRow: HTMLDivElement;
  flowInstructionInput: HTMLTextAreaElement;
  flowMode: boolean;
  flowSteps: FlowStep[];
  flowPickerOverlay: HTMLDivElement;
  flowPickerMenu: HTMLDivElement;
  flowPickerPending: FlowPickerMetadata | null;
}
