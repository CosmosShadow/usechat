// Coordinate mapping adapted from UseChat (MIT); see ../NOTICE.
export function screenPoint(snapshot, x, y) {
  const { bounds: b, width, height } = snapshot;
  if (![x, y, width, height, b?.x, b?.y, b?.width, b?.height].every(Number.isFinite)
    || width <= 0 || height <= 0 || b.width <= 0 || b.height <= 0
    || x < 0 || y < 0 || x >= width || y >= height) throw new Error('Point outside screenshot');
  return { x: b.x + x * b.width / width, y: b.y + y * b.height / height };
}
