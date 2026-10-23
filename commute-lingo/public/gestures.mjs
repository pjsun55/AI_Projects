// Movement cancels a long press so scrolling through subtitles never translates
// by accident. Keyboard activation and the context menu provide alternatives.
export function longPress(element, action, { delay = 480, tolerance = 10, timers = globalThis } = {}) {
  let timer, origin, consumed = false;
  const clear = () => { timers.clearTimeout(timer); timer = undefined; origin = undefined; };
  const invoke = () => { consumed = true; clear(); action(); };
  const down = event => {
    if (event.button !== undefined && event.button !== 0) return;
    clear(); consumed = false; origin = { x: event.clientX, y: event.clientY };
    timer = timers.setTimeout(invoke, delay);
  };
  const move = event => { if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > tolerance) clear(); };
  const click = event => { if (consumed) { event.preventDefault(); event.stopPropagation(); consumed = false; } };
  const menu = event => { event.preventDefault(); if (!consumed) invoke(); };
  const key = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); invoke(); } };
  const handlers = { pointerdown: down, pointermove: move, pointerup: clear, pointercancel: clear, pointerleave: clear, contextmenu: menu, click, keydown: key };
  for (const [name, handler] of Object.entries(handlers)) element.addEventListener(name, handler);
  return () => { clear(); for (const [name, handler] of Object.entries(handlers)) element.removeEventListener(name, handler); };
}

export function isMobileLandscape({ coarse, orientationType, orientationAngle, width, height }) {
  if (!coarse) return false;
  // Screen dimensions stay stable when a keyboard or split window shrinks the
  // viewport. Tablets use the responsive layout in either orientation.
  if (Number.isFinite(width) && Number.isFinite(height) && Math.min(width, height) >= 600) return false;
  if (typeof orientationType === 'string') return orientationType.startsWith('landscape');
  if (typeof orientationAngle === 'number') return Math.abs(orientationAngle) === 90;
  return width > height;
}
