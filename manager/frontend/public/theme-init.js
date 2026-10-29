// Apply theme before paint to avoid a flash of the wrong theme.
// An external file, not an inline script: the CSP allows scripts from 'self' only.
// Keep the resolution order identical to stores/theme.ts (readInitial):
//   1. 'kp-theme'    - current storage key
//   2. 'panel-theme' - legacy key, adopted when the current one is empty
//   3. prefers-color-scheme, otherwise dark
(function () {
  var root = document.documentElement;
  function apply(theme) {
    root.classList.toggle('dark', theme === 'dark');
    root.classList.toggle('light', theme === 'light');
  }
  try {
    var theme = localStorage.getItem('kp-theme');
    if (theme !== 'dark' && theme !== 'light') {
      theme = localStorage.getItem('panel-theme');
    }
    if (theme !== 'dark' && theme !== 'light') {
      theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    apply(theme);
  } catch (e) {
    apply('dark');
  }
})();
