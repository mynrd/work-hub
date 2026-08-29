// Light/dark toggle. The initial value is already on <html> - index.html sets it
// inline before first paint - so this only has to keep the icon and storage in sync.

const THEME_KEY = 'work-hub-theme';

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* storage blocked */ }
  var use = document.getElementById('themeIconUse');
  // The icon shows the theme a click switches TO, not the current one.
  if (use) use.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
}

export function initTheme() {
  applyTheme(currentTheme());
  document.getElementById('themeToggleBtn').addEventListener('click', function () {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });
}
