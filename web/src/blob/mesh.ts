// Unit icosphere: an icosahedron with each triangle split into four, `levels` times.
// Level 5 has 10 242 vertices, which still fits 16-bit indices.

export interface Mesh {
  positions: Float32Array<ArrayBuffer>;
  indices: Uint16Array<ArrayBuffer>;
}

export function icosphere(levels: number): Mesh {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(unit);
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let l = 0; l < levels; l++) {
    // Each edge is split once, shared by the two faces on it.
    const mids = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let i = mids.get(key);
      if (i === undefined) {
        const [p, q] = [verts[a], verts[b]];
        i = verts.push(unit([p[0] + q[0], p[1] + q[1], p[2] + q[2]])) - 1;
        mids.set(key, i);
      }
      return i;
    };
    faces = faces.flatMap(([a, b, c]) => {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]];
    });
  }
  return { positions: new Float32Array(verts.flat()), indices: new Uint16Array(faces.flat()) };
}

function unit([x, y, z]: number[]): number[] {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}
