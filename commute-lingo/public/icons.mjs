const paths = {
  repeat: '<path d="m16 3 4 4-4 4M4 11V9a2 2 0 0 1 2-2h14M8 21l-4-4 4-4m12 0v2a2 2 0 0 1-2 2H4"/>',
  book: '<path d="M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1ZM12 5v15"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>', pause: '<path d="M7 4h3v16H7zM15 4h3v16h-3z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="3"/>',
  previous: '<path d="M6 6v12m13-12-11 6 11 6Z"/>', next: '<path d="M18 6v12M5 6l11 6-11 6Z"/>',
  down: '<path d="m5 9 7 7 7-7"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  listen: '<path d="M4 14v-3a8 8 0 0 1 16 0v3M6 11H4v7h4v-7ZM18 11h2v7h-4v-7Z"/>',
  library: '<rect x="3" y="6" width="6" height="15" rx="1.5"/><rect x="11" y="3" width="5" height="18" rx="1.5"/><path d="m18 7 3-1 3 13-3 1"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  storage: '<path d="M3 7h18v13H3zM3 7l3-4h12l3 4M8 12h8M10 16h4"/>',
  settings: '<path d="m9 3-.5 3-2 1-3-.7L2 10l2.5 2v2L2 16l1.5 3.7 3-.7 2 1L9 23h6l.5-3 2-1 3 .7L22 16l-2.5-2v-2L22 10l-1.5-3.7-3 .7-2-1L15 3Z" transform="translate(0 -1) scale(1 .96)"/><circle cx="12" cy="12" r="3.5"/>',
  podcast: '<circle cx="12" cy="8" r="2"/><path d="M9 14a3 3 0 0 1 6 0l-1 7h-4ZM6.5 15a8 8 0 1 1 11 0M8 11a5 5 0 1 1 8 0"/>',
  youtube: '<rect x="2" y="5" width="20" height="14" rx="4"/><path d="m10 9 6 3-6 3Z"/>',
  link: '<path d="m10 14 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 -1)"/>',
  subtitles: '<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M6 10h5m3 0h4M6 14h3m3 0h6"/>',
  rotate: '<rect x="8" y="3" width="10" height="18" rx="2"/><path d="M4 9a8 8 0 0 0 0 10m0-10-3 2m3-2 2 3M13 17h0"/>',
  wave: '<path d="M3 10v4m4-8v12m5-16v20m5-16v12m4-8v4"/>',
  album: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M9 9h6M9 13h6M9 17h3"/>',
  trash: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>'
};
export const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${Object.hasOwn(paths, name) ? paths[name] : paths.wave}</svg>`;
export function fillIcons(root = document) { for (const element of root.querySelectorAll('[data-icon]')) element.innerHTML = icon(element.dataset.icon); }
