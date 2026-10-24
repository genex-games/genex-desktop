import { memo, useState } from "react";
import { t } from "../../shared/i18n.ts";
import { Icon } from "../ui/icons.tsx";
export const ActivityDetails = memo(function ActivityDetails({
  rows,
}: {
  rows: Array<{ text: string; tag?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(20);
  return (
    <div data-chat-activity-details>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="-mx-1.5 flex items-center gap-1.5 rounded-control px-1.5 py-1 text-[12.5px] text-ink-3 hover:bg-control-hover hover:text-control-text-hover"
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        {t("{count, plural, =1 {Activity details} other {# activity updates}}", { count: rows.length })}
      </button>
      {open && (
        <div className="ms-1.5 mt-1 space-y-1.5 border-s border-line ps-4 text-[12px] leading-relaxed text-ink-2">
          {rows.slice(-limit).map((row, index) => (
            <p key={index} className="break-words">
              {row.text}
            </p>
          ))}
          {rows.length > limit && (
            <button
              type="button"
              onClick={() => setLimit((n) => n + 20)}
              className="min-h-8 rounded-control px-2 hover:bg-control-hover"
            >
              {t("Show earlier updates")}
            </button>
          )}
        </div>
      )}
    </div>
  );
});
