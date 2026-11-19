// Le plan du bureau : un îlot par pôle, autant de chaises que de places, sans chevauchement,
// et chaque chaise reste accessible depuis la porte.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FURNITURE, SEATS, setPlaces, SPOTS, walkGrid } from '../src/engine/layout.ts';
import { findPath } from '../src/engine/path.ts';

for (const n of [1, 2, 3]) {
  test(`plan du bureau avec ${n} place(s) par pôle`, () => {
    setPlaces({ recherche: n, design: n, code: n, relecture: n, redaction: n });
    for (const role of ['recherche', 'design', 'code', 'relecture', 'redaction']) {
      assert.equal(SEATS.filter((s) => s.role === role).length, n, role);
    }
    // pas deux meubles sur la même case
    const taken = new Map<string, string>();
    for (const f of FURNITURE) {
      for (let y = f.ty; y < f.ty + f.h; y++) for (let x = f.tx; x < f.tx + f.w; x++) {
        const k = `${x},${y}`;
        assert.ok(!taken.has(k), `${f.id} chevauche ${taken.get(k)} en ${k}`);
        taken.set(k, f.id);
      }
    }
    // chaque chaise est libre et accessible depuis la porte
    const grid = walkGrid();
    for (const s of SEATS) {
      assert.ok(grid[s.tile[1]][s.tile[0]], `${s.id} est sur une case bloquée`);
      assert.ok(findPath(grid, SPOTS.door, s.tile), `${s.id} n'est pas accessible`);
    }
  });
}
