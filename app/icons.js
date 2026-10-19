'use strict';
/* ================= icons.js =================
 * 纯 SVG 图标资源。无依赖。
 */

const svg = (p, s = 16, w = 1.8) =>
  '<svg aria-hidden="true" focusable="false" width="' + s + '" height="' + s +
  '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + w +
  '" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';

export const I = {
  chev:  svg('<polyline points="9 6 15 12 9 18"/>', 14, 2),
  plus:  svg('<path d="M12 5v14M5 12h14"/>', 14, 2),
  dots:  '<svg aria-hidden="true" focusable="false" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>',
  drag:  '<svg aria-hidden="true" focusable="false" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.7"/><circle cx="15" cy="5" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="19" r="1.7"/><circle cx="15" cy="19" r="1.7"/></svg>',
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>', 14),
  pen:   svg('<path d="M4 20l4.5-1L20 7.5 16.5 4 5 15.5 4 20z"/>', 14),
  move:  svg('<path d="M4 18c0-6 4-9 10-9"/><path d="M11 5l4 4-4 4"/>', 14),
  send:  svg('<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>', 17, 2),
  search:svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>', 15),
  menu:  svg('<path d="M4 7h16M4 12h16M4 17h16"/>', 19),
  folder:svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', 14),
  refresh:svg('<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/>', 13),
  clip:  svg('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>', 17),
  pin:   svg('<path d="M12 17v5M9 3h6l1 7-4 4-4-4 1-7z"/>', 14),
  x:     svg('<path d="M6 6l12 12M18 6L6 18"/>', 13, 2.2),
  copy:  svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 14),
  palette:svg('<circle cx="13.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="17.5" cy="10.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="8.5" cy="7.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="6.5" cy="12.5" r="1.2" fill="currentColor" stroke="none"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1-.3-.3-.4-.6-.4-1 0-.9.7-1.6 1.6-1.6H16c3.3 0 6-2.7 6-6-.1-5-4.5-8.2-10-8.2z"/>', 14),
  md:    svg('<path d="M4 7h16M4 12h10M4 17h7"/>', 16),
  reply: svg('<path d="M9 17l-6-5 6-5"/><path d="M3 12h11a6 6 0 0 1 6 6v1"/>', 14),
  check: svg('<polyline points="20 6 9 17 4 12"/>', 14, 2.2),
  layers:svg('<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>', 14),
  import: svg('<path d="M12 3v11"/><polyline points="8 10 12 14 16 10"/><path d="M5 21h14"/>', 14, 2),
  relevance: svg('<path d="M 4 8 C 11 8, 11 16, 18 16" /><path d="M 4 16 C 11 16, 11 8, 18 8" />', 14, 1.8),
  sparkles: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/>', 16, 1.7),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>', 15, 2),
  pinSolid: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 17v5l-.5-.5L11 17h1zm-4-1.5V9c0-1 .5-2 1.5-2.5V4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2.5C15.5 7 16 8 16 9v6.5l1.5 1.5v1h-11v-1L8 15.5z"/></svg>',
};