/** Settings → Licenses: Genex's MIT license, then the third-party notices this build ships. */
import { type JSX, useEffect, useState } from "react";
import type { LicenseTexts } from "../../shared/licenses.ts";
import { unwrapMarkdown } from "../licenses-text.ts";
import { DialogSurface } from "../ui/dialog.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { LICENSE_WORDS, problemWords } from "../words.ts";
import { Pending } from "../ui/Pending.tsx";
import { SkeletonLines } from "../ui/Skeleton.tsx";

/** The texts once read, in reading order; empty when the build wrote none. */
function shownTexts(texts: LicenseTexts): { license: string | null; notices: string[] } {
  return { license: texts.license, notices: [texts.notices, texts.bundled].filter((text) => text !== null) };
}

/** The dialog's body: loading, a problem, a build without the files, or the texts. */
function LicensesBody({ texts, error }: { texts: LicenseTexts | null; error: string | null }): JSX.Element {
  if (error)
    return (
      <p role="alert" className="text-red">
        {error}
      </p>
    );
  if (!texts)
    return (
      <Pending label={LICENSE_WORDS.loading} className="flex flex-col gap-7">
        <SkeletonLines widths={["30%", "100%", "94%", "98%", "60%"]} />
        <SkeletonLines widths={["24%", "100%", "90%", "46%"]} />
      </Pending>
    );
  const { license, notices } = shownTexts(texts);
  if (!license && notices.length === 0) return <p className="text-ink-3">{LICENSE_WORDS.missing}</p>;
  return (
    <div data-licenses className="flex min-w-0 flex-col gap-6">
      {license && (
        <pre className="rounded-control bg-field p-3 font-mono text-micro text-ink-2 [overflow-wrap:anywhere] whitespace-pre-wrap">
          {license}
        </pre>
      )}
      {notices.map((text) => (
        <Markdown key={text.slice(0, 40)} text={unwrapMarkdown(text)} className="min-w-0" />
      ))}
    </div>
  );
}

/** The license texts in a modal over Settings, read once from the app's own resources. */
export function LicensesDialog({ onDismiss }: { onDismiss: () => void }): JSX.Element {
  const [texts, setTexts] = useState<LicenseTexts | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.studio
      .licenses()
      .then(setTexts)
      .catch((cause) => setError(problemWords(cause)));
  }, []);
  return (
    <DialogSurface
      title={LICENSE_WORDS.title}
      description={LICENSE_WORDS.intro}
      size="2xl"
      testId="licenses-dialog"
      // Only the texts scroll: the title and the close button stay in view however far you read.
      className="grid-rows-[auto_minmax(0,1fr)] overflow-y-hidden"
      onDismiss={onDismiss}
    >
      <div data-licenses-scroll className="-mx-5 min-h-0 overflow-y-auto px-5">
        <LicensesBody texts={texts} error={error} />
      </div>
    </DialogSurface>
  );
}
