// Apply theme before paint to avoid FOUC.
// An external file, not an inline script: the CSP allows scripts from 'self' only.
(function () {
  try {
    var stored = localStorage.getItem('panel-theme');
    var theme = stored || 'dark';
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  } catch (e) {
    document.documentElement.classList.add('dark');
  }
})();
