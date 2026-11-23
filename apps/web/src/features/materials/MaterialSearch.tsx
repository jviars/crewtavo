/**
 * The supplier's catalog at the business's branch, searched as you type, with the account's own
 * price on each item. Picking one is up to whoever shows it (MaterialPicker); on the ABC Supply
 * app's page it's for looking up a price.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { api } from "@/lib/api";
import { formatMoneyCents } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { CatalogItem } from "./data";

export function MaterialSearch({ initial = "", onPick, autoFocus }: { initial?: string; onPick?: (item: CatalogItem) => void; autoFocus?: boolean }) {
  const { company } = useSession();
  const [text, setText] = useState(initial);
  const [query, setQuery] = useState(initial.trim());
  // Ask once typing stops, not on every letter.
  useEffect(() => {
    const wait = setTimeout(() => setQuery(text.trim()), 400);
    return () => clearTimeout(wait);
  }, [text]);
  const results = useQuery({
    queryKey: ["material-search", company.id, query],
    enabled: query.length >= 2,
    queryFn: () => api.get<{ branch_name: string; items: CatalogItem[] }>(`/materials/search?${new URLSearchParams({ q: query })}`),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const items = results.data?.items ?? [];
  return (
    <div className="stack-sm" style={{ gap: 10 }}>
      <div className="input-group material-search">
        <span className="addon"><Icon name="search" size={14} /></span>
        <input
          className="input"
          type="search"
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          placeholder="Brand, color or item number, like Timberline Charcoal"
          aria-label="Search ABC Supply's catalog"
          style={{ paddingLeft: 32 }}
        />
      </div>
      {query.length < 2 ? (
        <span className="muted small">Search by brand, product and color, like <strong>Timberline Charcoal</strong> or <strong>drip edge white</strong>, or paste an ABC item number.</span>
      ) : results.isPending ? (
        <div className="material-results" role="status">
          <span className="sr-only">Looking at your branch…</span>
          {[0, 1, 2].map((i) => (
            <div key={i} className="material-result" aria-hidden="true">
              <span className="grow" style={{ gap: 6 }}><Skeleton width={["52%", "40%", "46%"][i]} height={11} /><Skeleton width="22%" height={9} /></span>
              <Skeleton width={64} height={11} />
            </div>
          ))}
        </div>
      ) : results.error ? (
        <span className="field-error" role="alert">{(results.error as Error).message}</span>
      ) : !items.length ? (
        <span className="muted small" role="status">Nothing at {results.data?.branch_name ?? "your branch"} matches “{query}”. Try fewer words, or the brand's name.</span>
      ) : (
        <div className="material-results" role="list" aria-label={`Items at ${results.data?.branch_name}`}>
          {items.map((item) => {
            const unit = item.uoms.find((u) => u.code === item.uom)?.name ?? item.uom;
            const body = (
              <>
                <span className="grow">
                  <strong>{item.name}</strong>
                  <span className="muted">{[item.item_number, item.color].filter(Boolean).join(" · ")}</span>
                </span>
                <span className="num material-price">
                  {item.unit_price !== null ? <><strong>{formatMoneyCents(item.unit_price)}</strong> / {unit.toLowerCase()}</> : (item.note ?? "No price")}
                </span>
                {onPick && <span className="icon-chevron" aria-hidden="true"><Icon name="chevronRight" size={16} /></span>}
              </>
            );
            return onPick ? (
              <button key={item.item_number} type="button" role="listitem" className="material-result" onClick={() => onPick(item)}>{body}</button>
            ) : (
              <div key={item.item_number} role="listitem" className="material-result">{body}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}
