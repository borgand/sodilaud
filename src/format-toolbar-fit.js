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
