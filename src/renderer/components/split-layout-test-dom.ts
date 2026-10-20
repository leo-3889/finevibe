// Side-effect helper for split-layout.test.ts — static imports evaluate in order,
// and split-layout.ts resolves `#terminal-container` and state.ts persists through
// the preload bridge at import time, so the DOM + bridge must exist before those
// modules load. A static import of the real modules cannot work without this.
// SAFETY: jsdom types do not include the app's `vibeyard` global augmentation
// (it lives in the renderer tsconfig's ambient types); the object literal below
// implements exactly the preload-bridge surface state.ts touches (store, session).
(window as unknown as { vibeyard: unknown }).vibeyard = {
  store: { load: () => {}, save: () => {} },
  session: { transcriptExistsSync: () => false },
};
document.body.innerHTML = '<div id="terminal-container"></div>';
