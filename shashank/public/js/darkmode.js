(function () {
  var DARK = 'dark-mode';
  var storageKey = 'theme';

  if (localStorage.getItem(storageKey) === DARK) {
    document.documentElement.setAttribute('theme', DARK);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var nav = document.querySelector('nav.navigation');
    if (!nav) return;

    var btn = document.createElement('button');
    btn.id = 'dark-toggle';
    btn.setAttribute('aria-label', 'Toggle dark mode');
    btn.style.cssText = [
      'background:none',
      'border:none',
      'cursor:pointer',
      'font-size:1rem',
      'padding:0 0 0 1rem',
      'color:inherit',
      'vertical-align:middle',
      'line-height:1',
    ].join(';');

    function update() {
      var isDark = document.documentElement.getAttribute('theme') === DARK;
      btn.textContent = isDark ? '[light]' : '[dark]';
    }

    btn.addEventListener('click', function () {
      var isDark = document.documentElement.getAttribute('theme') === DARK;
      if (isDark) {
        document.documentElement.removeAttribute('theme');
        localStorage.setItem(storageKey, 'light');
      } else {
        document.documentElement.setAttribute('theme', DARK);
        localStorage.setItem(storageKey, DARK);
      }
      update();
    });

    update();
    nav.appendChild(btn);
  });
})();