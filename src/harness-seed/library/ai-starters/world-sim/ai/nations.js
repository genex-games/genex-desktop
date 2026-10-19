/** The continent as the game starts it: the six nations and which of them share a border. */
export const NATIONS = [
  { id: "aurel", name: "Aurel", troops: 1200, stance: 0, stability: 3 },
  { id: "brenn", name: "Brenn", troops: 900, stance: 1, stability: 3 },
  { id: "calder", name: "Calder", troops: 1500, stance: -1, stability: 2 },
  { id: "dorvan", name: "Dorvan", troops: 700, stance: 0, stability: 4 },
  { id: "esk", name: "Esk", troops: 600, stance: 2, stability: 3 },
  { id: "fallow", name: "Fallow", troops: 1100, stance: -2, stability: 2 },
];

/** Neighbours: only these pairs may go to war. */
export const BORDERS = [
  ["aurel", "brenn"],
  ["aurel", "calder"],
  ["brenn", "dorvan"],
  ["calder", "dorvan"],
  ["calder", "fallow"],
  ["dorvan", "esk"],
  ["esk", "fallow"],
];

/** Whether two nations share a border. */
export const sharesBorder = (a, b) => BORDERS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
