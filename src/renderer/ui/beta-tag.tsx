/** A provider that ships in beta, said beside its name: the quiet pill a free model's tag uses. */
import type { JSX } from "react";
import { MODEL_PICKER_WORDS } from "../words.ts";

/** "Beta", beside a beta provider's name in Settings and its group in the model picker. */
export function BetaTag(): JSX.Element {
  return (
    <span className="beta-tag" data-beta-tag>
      {MODEL_PICKER_WORDS.beta}
    </span>
  );
}
