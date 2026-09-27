// SPDX-License-Identifier: GPL-3.0-or-later

export function getChangedRange(previousValue, nextValue) {
  let start = 0;
  while (
    start < previousValue.length &&
    start < nextValue.length &&
    previousValue[start] === nextValue[start]
  ) start += 1;

  let previousEnd = previousValue.length;
  let nextEnd = nextValue.length;
  while (
    previousEnd > start &&
    nextEnd > start &&
    previousValue[previousEnd - 1] === nextValue[nextEnd - 1]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  return {
    start,
    previousEnd,
    replacement: nextValue.slice(start, nextEnd)
  };
}
