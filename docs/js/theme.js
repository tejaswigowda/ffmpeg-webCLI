// js/theme.js — runs synchronously in <head> BEFORE <body> paints.
// Kept as a plain (non-module) script so its functions are global and
// callable from inline onclick="toggleTheme()" attributes in the HTML.
// The goal is to avoid a flash of the wrong theme on first paint.
(function () {
  var saved = localStorage.getItem('fwc-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
})();

function toggleTheme() {
  var root = document.documentElement;
  var cur = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  var next = cur === 'light' ? 'dark' : 'light';
  root.classList.add('theme-switching');
  root.setAttribute('data-theme', next);
  localStorage.setItem('fwc-theme', next);
  void root.offsetWidth;
  requestAnimationFrame(function () { requestAnimationFrame(function () { root.classList.remove('theme-switching'); }); });
  syncThemeToggle();
}

function syncThemeToggle() {
  var t = document.getElementById('themeToggle');
  if (!t) return;
  var light = document.documentElement.getAttribute('data-theme') === 'light';
  t.innerHTML = light ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', light ? '#E7EAF1' : '#0c0e13');
}

document.addEventListener('DOMContentLoaded', syncThemeToggle);
