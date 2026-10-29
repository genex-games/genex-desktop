/**
 * A person's avatar as Play draws everyone (the plate, profiles, friends, search, creators): the
 * photo they chose, else the animated avatar generated from their account id (and the variant they
 * regenerated to). A photo that fails to
 * load falls back to the generated one.
 */
import type { JSX } from "react";
import { useMemo, useState } from "react";
import { avatarRecipe } from "../../shared/avatar-recipe.ts";
import type { PlayPerson } from "../../shared/play-people.ts";
import { AvatarMotion, GeneratedAvatar } from "../avatars/GeneratedAvatar.tsx";

/**
 * One person's avatar, `size` pixels a side. `gear` leaves room around the body for horns and
 * jacks (large sizes); without it the body fills the round box. Still unless hovered by default.
 */
export function PersonAvatar({
  person,
  size,
  gear = false,
  flat = false,
  motion = AvatarMotion.Hover,
}: {
  person: Pick<PlayPerson, "id" | "imageUrl" | "avatarVariant">;
  size: number;
  gear?: boolean;
  /** Drawn as genex.games' link previews draw it (`GeneratedAvatar`'s `flat`). */
  flat?: boolean;
  motion?: AvatarMotion;
}): JSX.Element {
  const [failed, setFailed] = useState<string | null>(null);
  const recipe = useMemo(() => avatarRecipe(person.id, person.avatarVariant), [person.id, person.avatarVariant]);
  const src = person.imageUrl && failed !== person.imageUrl ? person.imageUrl : null;
  if (src)
    return (
      <span className="person-avatar" data-photo style={{ width: size, height: size }} aria-hidden="true">
        <img src={src} alt="" draggable={false} onError={() => setFailed(src)} />
      </span>
    );
  return <GeneratedAvatar recipe={recipe} size={size} full={!gear} flat={flat} motion={motion} />;
}
