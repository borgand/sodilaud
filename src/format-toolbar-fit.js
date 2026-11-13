// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * How many leading toolbar items fit in `available` pixels. When some do not
 * fit, room is kept for the overflow button that lists the rest. Without
 * layout (jsdom, or a hidden toolbar) every item counts as visible.
 * @param {number} available
 * @param {number[]} widths item widths in priority order
 * @param {number} overflowWidth
 * @returns {number}
 */
export function getVisibleItemCount(available, widths, overflowWidth) {
  const sizes = widths.map(width => (Number.isFinite(width) && width > 0 ? width : 0));
  const total = sizes.reduce((sum, width) => sum + width, 0);
  if (!(available > 0) || total <= 0 || total <= available) return sizes.length;

  let used = Number.isFinite(overflowWidth) ? overflowWidth : 0;
  let count = 0;
  for (const width of sizes) {
    if (used + width > available) break;
    used += width;
    count += 1;
  }
  return count;
}

/**
 * The toolbar's room once the title beside it keeps `titleMinWidth`: whatever
 * the layout squeezed the title below that comes off the toolbar, which then
 * moves buttons into the overflow menu instead of hiding the file name. A
 * laid-out toolbar keeps at least 1px, since no room at all means no layout.
 * @param {number} available
 * @param {number} titleWidth the title's measured width
 * @param {number} titleMinWidth
 * @returns {number}
 */
export function roomBesideTitle(available, titleWidth, titleMinWidth) {
  if (!(available > 0)) return available;
  const minimum = Number.isFinite(titleMinWidth) && titleMinWidth > 0 ? titleMinWidth : 0;
  const width = Number.isFinite(titleWidth) && titleWidth > 0 ? titleWidth : 0;
  return Math.max(1, available - Math.max(0, minimum - width));
}
