/**
 * The git command lines an open Loop reads its game folder with: its uncommitted changes, its
 * content as one id at a turn's edge, git's list of changes as one id when that can't be read, and
 * the last commit's tree. None writes the folder's own index or its object store. They live in a module of
 * their own because the shipped `loop/git.ts` may gain no key another module reads: an in-app
 * agent's kept older copy would lack it.
 */
import { shellQuote } from "../../shell.ts";

/**
 * How old, in minutes, a turn read's leftovers in the game's git folder are once no read can still be
 * using them: well past a read's own time limit (two minutes). Another run's are cleared after this.
 */
export const TURN_LEFTOVER_MINUTES = 10;

/**
 * `t <index> <excludes>`: the repository in the current folder read into `<index>` (a copy of its own
 * index first, so only files changed since are hashed again) and written as a tree into the run's
 * store (`$o`), which reads that repository's objects as its alternate (listed in a file: a path with
 * `:` or `;` is no list). Every git call runs with no LFS filter (git-lfs would copy a file into
 * `.git/lfs`, install its hooks, or fail where it isn't installed) and no optional locks; `<excludes>`, when
 * given, is an ignore file read beside the repository's own. A repository nested in it with no commit
 * yet is left out (git can't stage it).
 */
const READ_ONE = [
  "t() {",
  '  x="$1"; e="$2"',
  '  g() { GIT_INDEX_FILE="$x" GIT_OBJECT_DIRECTORY="$o" GIT_OPTIONAL_LOCKS=0 git -c filter.lfs.process= -c filter.lfs.clean= -c filter.lfs.smudge= -c filter.lfs.required=false ${e:+-c} ${e:+"core.excludesFile=$e"} "$@"; }',
  '  a="$(git rev-parse --path-format=absolute --git-path objects)" || return 1',
  '  printf \'%s\\n\' "$a" >"$o/info/alternates" || return 1',
  '  rm -f "$x" "$x.u"',
  '  cp "$(git rev-parse --git-path index)" "$x" 2>/dev/null',
  '  g ls-files -o --directory --exclude-standard >"$x.u" || return 1',
  "  set --",
  "  while IFS= read -r p; do",
  '    d="${p%/}"',
  '    if [ "$d" != "$p" ] && [ -e "./$d/.git" ] && ! git -C "./$d" rev-parse -q --verify HEAD >/dev/null 2>&1; then set -- "$@" ":(exclude,literal)$d"; fi',
  '  done <"$x.u"',
  '  g add -A -- . "$@" && g write-tree',
  "}",
].join("\n");

/** The git commands that read an open Loop's game folder. */
export const FOLDER_GIT = {
  /**
   * The game folder's uncommitted changes as git lists them. A nested repository's own uncommitted
   * work is left out: no commit of the folder can take it, so it would read as changed after every
   * save. A look that never writes the folder's index (`--no-optional-locks`): another chat's
   * checkpoint or a worker's git in the folder never meets its lock.
   */
  status: "git --no-optional-locks status --porcelain --ignore-submodules=dirty",
  /** git's list of the folder's changes, as one id, read without touching its index. */
  statusDigest: "git --no-optional-locks status --porcelain -z --untracked-files=all | git hash-object --stdin",
  /** The tree of the folder's last commit. */
  headTree: "git rev-parse HEAD^{tree}",
  /**
   * The game folder's content as one id: every file git doesn't ignore, staged into an index of the
   * read's own (the folder's index, and a worker's merge on it, are never touched) and written as a
   * tree into a store of the run's own in the game's git folder (`genex-turn-<run>.objects`, which
   * reads the game's objects through it and is never merged into them: a large file the checkpoints
   * leave out leaves no copy in the game's store, and each version of a file is compressed once in a
   * run; no LFS filter runs, so an LFS file is read as its bytes once it changes). A repository nested in the folder (an addon kept as a repository of its own) is read the
   * same way inside it, with the folder's own ignore rules too, so work there counts and its build
   * output doesn't; one that can't be read fails the read (never a change), and one with no commit yet
   * is left out. With none, the id is the folder's tree. The run's leftovers of a read the sandbox
   * killed go first, and another run's once they are `TURN_LEFTOVER_MINUTES` old: one stale lock
   * never blinds every later read, and nothing a run left stays for good.
   */
  tree: (runId: string): string => {
    const base = shellQuote(`genex-turn-${runId}`);
    const own = shellQuote(`genex-turn-${runId}.*`);
    return [
      `b="$(git rev-parse --path-format=absolute --git-path ${base})" || exit 1`,
      `find "\${b%/*}" -maxdepth 1 -name 'genex-turn-*' ! -name ${own} -mmin +${TURN_LEFTOVER_MINUTES} -exec rm -rf {} + 2>/dev/null`,
      'rm -rf "$b".index*',
      'i="$b.index.$$"; o="$b.objects"',
      `trap 'rm -rf "$i" "$i".*' EXIT`,
      'mkdir -p "$o/info" && touch "$o" || exit 1',
      'top="$(git rev-parse --show-toplevel)" || exit 1',
      READ_ONE,
      'r="$(t "$i" "")" || exit 1',
      'e=""; [ -f "$top/.gitignore" ] && e="$top/.gitignore"',
      'GIT_INDEX_FILE="$i" git -c core.quotePath=false ls-files -s >"$i.s" || exit 1',
      `n="$(awk -F '\\t' '$1 ~ /^160000 / { print $2 }' "$i.s" | while IFS= read -r p; do if [ -e "./$p/.git" ]; then h="$(cd "./$p" && t "$i.n" "$e")" || exit 1; printf '%s %s\\n' "$p" "$h"; fi; done)" || exit 1`,
      `if [ -z "$n" ]; then printf '%s\\n' "$r"; else printf '%s\\n%s\\n' "$r" "$n" | git hash-object --stdin; fi`,
    ].join("\n");
  },
  /** Removes the run's store and every leftover of its reads from the game's git folder: the Loop is over. */
  dropTurnStore: (runId: string): string =>
    `b="$(git rev-parse --path-format=absolute --git-path ${shellQuote(`genex-turn-${runId}`)})" && rm -rf "$b".index* "$b.objects"`,
} as const;
