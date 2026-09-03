// Floating jump button, present on every page. Scrolled down it jumps to the
// top; already at the top it flips and jumps to the bottom. Draggable along the
// bottom edge; the spot survives reloads via localStorage.

const POS_KEY = 'work-hub-scroll-jump-x';
const TOP_THRESHOLD = 40;   // px of scroll under which the page counts as "at the top"
const DRAG_THRESHOLD = 6;   // px of pointer travel that turns a click into a drag
const EDGE_GAP = 8;         // px kept between the button and the viewport edges

export function initScrollJump() {
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'scroll-jump';
  btn.innerHTML = '<svg class="icon"><use href="#i-arrow-up"/></svg>';
  document.body.appendChild(btn);

  function atTop() { return window.scrollY < TOP_THRESHOLD; }

  function sync() {
    // No point showing it on a page that fits the viewport.
    btn.hidden = document.documentElement.scrollHeight <= window.innerHeight + TOP_THRESHOLD;
    var down = atTop();
    btn.classList.toggle('is-down', down);
    var label = down ? 'Scroll to bottom' : 'Scroll to top';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  // ---- Horizontal drag (relocate left / middle / right) ---------------------

  var dragging = false, moved = false, startX = 0, startLeft = 0;

  function clampLeft(left) {
    return Math.min(Math.max(left, EDGE_GAP), window.innerWidth - btn.offsetWidth - EDGE_GAP);
  }

  /* Position is stored as the button centre's fraction of the viewport width,
     so it stays where it visually was after a resize or on another screen. */
  function applyStored() {
    var frac = parseFloat(localStorage.getItem(POS_KEY));
    if (isNaN(frac)) { btn.style.left = ''; btn.style.right = ''; return; }
    btn.style.right = 'auto';
    btn.style.left = clampLeft(frac * window.innerWidth - btn.offsetWidth / 2) + 'px';
  }

  btn.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    dragging = true; moved = false;
    startX = e.clientX;
    startLeft = btn.getBoundingClientRect().left;
    btn.setPointerCapture(e.pointerId);
  });

  btn.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    if (!moved && Math.abs(e.clientX - startX) < DRAG_THRESHOLD) return;
    moved = true;
    btn.style.right = 'auto';
    btn.style.left = clampLeft(startLeft + (e.clientX - startX)) + 'px';
  });

  btn.addEventListener('pointerup', function () {
    if (!dragging) return;
    dragging = false;
    if (!moved) return;
    var rect = btn.getBoundingClientRect();
    try { localStorage.setItem(POS_KEY, String((rect.left + rect.width / 2) / window.innerWidth)); } catch (e) { /* storage blocked - position just won't persist */ }
  });

  btn.addEventListener('pointercancel', function () { dragging = false; });

  btn.addEventListener('click', function () {
    if (moved) { moved = false; return; } // the click at the end of a drag is not a jump
    var top = atTop() ? document.documentElement.scrollHeight : 0;
    window.scrollTo({ top: top, behavior: 'smooth' });
  });

  window.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', function () { applyStored(); sync(); });
  // Route changes and data loads swap #app's contents; page height changes with them.
  new MutationObserver(sync).observe(document.getElementById('app'), { childList: true, subtree: true });

  applyStored();
  sync();
}
