/**
 * The Assets canvas's tabs and sort order, beside its search box: All and one tab per media kind
 * with how many files each holds, and a menu for how a source's cards run.
 */
import type { JSX } from "react";
import { ASSET_TABS, AssetOrder, type AssetTab } from "../../assets-filter.ts";
import { Button } from "../../ui/Button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu.tsx";
import { Icon } from "../../ui/icons.tsx";
import { ViewSwitcher } from "../../ui/view-switcher.tsx";
import { ASSET_LIBRARY_WORDS as WORDS } from "../../words.ts";

const ORDERS: readonly AssetOrder[] = Object.values(AssetOrder);
const isOrder = (value: string): value is AssetOrder => (ORDERS as readonly string[]).includes(value);

/** The tabs: the current one tinted, each with its count. */
export function AssetTabs({
  tab,
  counts,
  onTab,
}: {
  tab: AssetTab;
  counts: Record<AssetTab, number>;
  onTab: (tab: AssetTab) => void;
}): JSX.Element {
  return (
    <ViewSwitcher
      sans
      label={WORDS.tabsLabel}
      items={ASSET_TABS.map((key) => ({ key, label: WORDS.tabs[key], count: counts[key] }))}
      active={tab}
      onSelect={onTab}
      dataAttribute="data-assets-tab"
      className="no-drag"
    />
  );
}

/** The sort order's menu, named by the order it is in. */
export function AssetSort({
  order,
  onOrder,
}: {
  order: AssetOrder;
  onOrder: (order: AssetOrder) => void;
}): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          aria-label={WORDS.sortLabel}
          data-assets-sort={order}
          className="asset-sort no-drag"
        >
          {WORDS.orders[order]}
          <Icon name="chevron-down" size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={order}
          onValueChange={(value) => {
            if (isOrder(value)) onOrder(value);
          }}
        >
          {ORDERS.map((each) => (
            <DropdownMenuRadioItem key={each} value={each} data-assets-order={each}>
              {WORDS.orders[each]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
