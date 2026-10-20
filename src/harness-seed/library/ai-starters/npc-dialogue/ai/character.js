/** The character: who they are, what they know (by id) and what they carry. The model knows nothing else. */
export const CHARACTER = {
  id: "mira",
  name: "Mira",
  role: "the village smith",
  manner: "short-spoken, proud of her work, kind to honest people",
};

/** What Mira knows, by id: the only topics an answer may name. */
export const FACTS = [
  { id: "forge", text: "Her forge burns charcoal from the north wood; she relit it this spring." },
  { id: "river-ford", text: "The river ford flooded last week; a cart and its iron were lost there." },
  { id: "lost-hammer", text: "Her father's hammer went missing the night of the flood." },
  { id: "iron-price", text: "Iron is dear since the ford flooded; she trades only for fair goods." },
];

/** What Mira carries: the only items she can hand over. */
export const ITEMS = ["iron-nail", "horseshoe", "old-key"];
