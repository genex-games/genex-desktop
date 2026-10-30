/**
 * The taste judge no longer decides a round (Loop phase 4): a round is kept on its board, with no
 * judge call (facet/kept-round.ts). This name stays for a kept older verify.ts that still calls it,
 * and it keeps the round the same way.
 */
export { keepOnBoard as tasteVerdict } from "../kept-round.ts";
